/**
 * Tuple routes — the storage-mutating and storage-reading surface:
 *
 *   POST /stores/:storeId/write    apply tuple writes + deletes (transactional)
 *   POST /stores/:storeId/read     read tuples (cursor-paginated)
 *   GET  /stores/:storeId/changes  tuple changelog (cursor-paginated,
 *                                  oldest-first, polling-tail semantics)
 */
import { Hono } from 'hono'
import {
  DuplicateTupleError,
  conditionOnWire,
  InvalidObjectReferenceError,
  MissingTupleError,
  applyTupleMutations,
  listChangesPage,
  readTuplesPage,
  type ReadTupleCursor,
  type TupleConflictMode,
} from '../storage/tuples'
import { loadModelIndex } from '../storage/engine-context'
import { validate } from '../middleware/validation'
import { ChangesQuery, ReadBody, WriteBody } from './schemas'
import { validateWriteTupleKey } from './write-validation'
import {
  decodeChangeCursor,
  decodeReadCursor,
  encodeChangeCursor,
  encodeReadCursor,
  type ChangeCursor,
} from './_helpers/cursors'

export const tuplesRoutes = new Hono()

tuplesRoutes.post('/stores/:storeId/write', validate('json', WriteBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const writes = body.writes?.tuple_keys ?? []
  const deletes = body.deletes?.tuple_keys ?? []

  const onDuplicate = body.writes?.on_duplicate ?? 'error'
  const onMissing = body.deletes?.on_missing ?? 'error'

  const ctx = writes.length > 0 || body.authorization_model_id
    ? await loadModelIndex(storeId, body.authorization_model_id)
    : null
  if ((writes.length > 0 || body.authorization_model_id) && !ctx) {
    return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
  }

  if (ctx) {
    for (const tuple of writes) {
      const invalid = validateWriteTupleKey(ctx.index, tuple)
      if (invalid) return c.json({ code: 'invalid_argument', message: invalid }, 400)
    }
  }

  try {
    await applyTupleMutations(storeId, {
      writes,
      deletes,
      onDuplicate: onDuplicate as TupleConflictMode,
      onMissing: onMissing as TupleConflictMode,
    })
  }
  catch (err) {
    if (err instanceof DuplicateTupleError || err instanceof MissingTupleError) {
      return c.json({ code: 'conflict', message: err.message }, 409)
    }
    throw err
  }
  return c.json({})
})

tuplesRoutes.post('/stores/:storeId/read', validate('json', ReadBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const tk = body.tuple_key
  let cursor: ReadTupleCursor | null = null
  if (body.continuation_token !== undefined && body.continuation_token.length > 0) {
    cursor = decodeReadCursor(body.continuation_token)
    if (cursor === null) {
      return c.json({ code: 'invalid_argument', message: 'continuation_token is malformed' }, 400)
    }
  }
  let page
  try {
    page = await readTuplesPage(
      storeId,
      {
        object: tk?.object,
        relation: tk?.relation,
        user: tk?.user,
        pageSize: body.page_size,
      },
      cursor,
    )
  }
  catch (err) {
    if (err instanceof InvalidObjectReferenceError) {
      return c.json({ code: 'invalid_argument', message: err.message }, 400)
    }
    throw err
  }
  return c.json({
    tuples: page.rows.map(r => ({
      key: {
        ...conditionOnWire(r),
        user: r.user_str,
        relation: r.relation,
        object: `${r.object_type}:${r.object_id}`,
      },
      timestamp: r.inserted_at,
    })),
    continuation_token: page.nextCursor === null ? '' : encodeReadCursor(page.nextCursor),
  })
})

// Per OpenFGA's ReadChanges semantics: oldest-first ordering (see
// listChangesPage), and an exhausted continuation read echoes the
// supplied token so polling-tail clients can resume from the same
// position when new events arrive. See openfga-ra9.
tuplesRoutes.get('/stores/:storeId/changes', validate('query', ChangesQuery), async (c) => {
  const storeId = c.req.param('storeId')
  const { type, page_size, continuation_token, start_time } = c.req.valid('query')
  const pageSize = Math.min(Math.max(page_size ?? 50, 1), 100)
  const suppliedToken = (continuation_token !== undefined && continuation_token.length > 0)
    ? continuation_token
    : null
  const requestType: string | null = type ?? null
  let cursor: ChangeCursor | null = null
  if (suppliedToken !== null) {
    cursor = decodeChangeCursor(suppliedToken)
    if (cursor === null) {
      return c.json({ code: 'invalid_argument', message: 'continuation_token is malformed' }, 400)
    }
    // Cross-filter token reuse is rejected: a token issued under one
    // type filter is not valid under a different filter.
    if (cursor.type !== requestType) {
      return c.json({
        code: 'invalid_argument',
        message: cursor.type === null
          ? 'continuation_token was issued without a type filter; do not pass `type` on the continuation call'
          : `continuation_token was issued with type=${cursor.type}; the same type filter must be supplied`,
      }, 400)
    }
  }
  const page = await listChangesPage(storeId, pageSize, cursor, {
    objectType: type,
    startTime: start_time,
  })

  // Pick the response token:
  //   - If we returned new rows, the next cursor either advances (more
  //     rows after this page) or wraps to the last row's position
  //     (this page exhausts current history; future polls resume after
  //     the last seen row).
  //   - If we returned no rows AND the caller supplied a token, echo
  //     that token so the next poll re-checks the same position for
  //     newly-arrived events.
  //   - Otherwise (no rows, no supplied token), the timeline is empty
  //     for this caller; return an empty token so a fresh call starts
  //     from scratch.
  let responseToken: string
  if (page.nextCursor !== null) {
    responseToken = encodeChangeCursor({ ...page.nextCursor, type: requestType })
  }
  else if (page.rows.length > 0) {
    const last = page.rows[page.rows.length - 1]!
    responseToken = encodeChangeCursor({
      inserted_at: last.inserted_at,
      seq: last.seq,
      type: requestType,
    })
  }
  else if (suppliedToken !== null) {
    responseToken = suppliedToken
  }
  else {
    responseToken = ''
  }

  return c.json({
    changes: page.rows.map((r) => ({
      tuple_key: {
        ...conditionOnWire(r),
        user: r.user_str,
        relation: r.relation,
        object: `${r.object_type}:${r.object_id}`,
      },
      operation: r.operation,
      timestamp: r.inserted_at,
    })),
    continuation_token: responseToken,
  })
})
