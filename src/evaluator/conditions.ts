import type { Condition, ConditionParamTypeRef, RelationshipCondition } from '@openfga/sdk'
import { Environment } from '@marcbachmann/cel-js'
import { celEnv, celFunc, celMethod, CelScalar as S, celUint, isCelError, listType, mapType, objectType, parse, plan, run } from '@bufbuild/cel'
import type { CelInput, CelType } from '@bufbuild/cel'
import { create, createFileRegistry, createRegistry, fromJson } from '@bufbuild/protobuf'
import { FileDescriptorProtoSchema, TimestampSchema, DurationSchema } from '@bufbuild/protobuf/wkt'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { RE2JS } from 're2js'
import { integerParameter, doubleParameter } from './condition-numbers'

export class ConditionError extends Error {
  readonly code = 'validation_error'
}

const ipRegistry = createFileRegistry(create(FileDescriptorProtoSchema, {
  name: 'nodefga_ip.proto', syntax: 'proto3', messageType: [{
    name: 'IPAddress', field: [{ name: 'address', number: 1, type: 9, label: 1 }],
  }],
}), () => undefined)
const ipSchema = ipRegistry.getMessage('IPAddress')!
const ipType = objectType(ipSchema)
const ipField = ipSchema.fields[0]!

function canonicalIp(value: unknown): string {
  if (typeof value !== 'string' || !isIP(value)) throw new Error('invalid IP address')
  return ipaddr.process(value).toString()
}

function inCidr(address: string, cidr: string): boolean {
  const [network, bits] = ipaddr.parseCIDR(cidr)
  const ip = ipaddr.process(address)
  if (network.kind() === 'ipv6' && (network as ipaddr.IPv6).isIPv4MappedAddress() && bits >= 96) {
    return ip.kind() === 'ipv4' && (ip as ipaddr.IPv4).match((network as ipaddr.IPv6).toIPv4Address(), bits - 96)
  }
  if (ip.kind() !== network.kind()) return false
  return ip.kind() === 'ipv4'
    ? (ip as ipaddr.IPv4).match(network as ipaddr.IPv4, bits)
    : (ip as ipaddr.IPv6).match(network as ipaddr.IPv6, bits)
}

const funcs = [
  celFunc('ipaddress', [S.STRING], ipType, value => create(ipSchema, { address: canonicalIp(value) })),
  celMethod('in_cidr', ipType, [S.STRING], S.BOOL, function (cidr) {
    return inCidr(this.get(ipField) as string, cidr)
  }),
  celFunc('string', [ipType], S.STRING, ip => ip.get(ipField) as string),
]

const primitive: Record<string, [string, CelType]> = {
  TYPE_NAME_ANY: ['dyn', S.DYN], TYPE_NAME_BOOL: ['bool', S.BOOL],
  TYPE_NAME_STRING: ['string', S.STRING], TYPE_NAME_INT: ['int', S.INT],
  TYPE_NAME_UINT: ['uint', S.UINT], TYPE_NAME_DOUBLE: ['double', S.DOUBLE],
  TYPE_NAME_TIMESTAMP: ['google.protobuf.Timestamp', objectType(TimestampSchema)],
  TYPE_NAME_DURATION: ['google.protobuf.Duration', objectType(DurationSchema)],
  TYPE_NAME_IPADDRESS: ['IPAddress', ipType],
}

function parameterType(ref: ConditionParamTypeRef, depth = 0): [string, CelType] {
  if (!ref || depth > 20) throw new Error('invalid condition parameter type')
  const generic = ref.generic_types ?? []
  if (ref.type_name === 'TYPE_NAME_LIST' || ref.type_name === 'TYPE_NAME_MAP') {
    if (generic.length !== 1) throw new Error('list/map requires one generic type')
    const [name, type] = parameterType(generic[0]!, depth + 1)
    return ref.type_name === 'TYPE_NAME_LIST' ? [`list<${name}>`, listType(type)] : [`map<string, ${name}>`, mapType(S.STRING, type)]
  }
  const type = primitive[ref.type_name]
  if (!type || generic.length) throw new Error('invalid condition parameter type')
  return type
}

function convert(value: unknown, ref: ConditionParamTypeRef): CelInput {
  switch (ref.type_name) {
    case 'TYPE_NAME_ANY': return jsonValue(value)
    case 'TYPE_NAME_BOOL': if (typeof value === 'boolean') return value; break
    case 'TYPE_NAME_STRING': if (typeof value === 'string') return value; break
    case 'TYPE_NAME_INT': return integerParameter(value, false)
    case 'TYPE_NAME_UINT': return celUint(integerParameter(value, true))
    case 'TYPE_NAME_DOUBLE': return doubleParameter(value)
    case 'TYPE_NAME_TIMESTAMP':
      if (typeof value === 'string') return fromJson(TimestampSchema, value)
      break
    case 'TYPE_NAME_DURATION': {
      if (typeof value !== 'string') break
      const duration = run('duration(value)', { value })
      if (isCelError(duration)) throw duration
      return duration
    }
    case 'TYPE_NAME_IPADDRESS': return create(ipSchema, { address: canonicalIp(value) })
    case 'TYPE_NAME_LIST':
      if (Array.isArray(value)) return value.map(item => convert(item, ref.generic_types![0]!))
      break
    case 'TYPE_NAME_MAP':
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return new Map(Object.entries(value).map(([key, item]) => [key, convert(item, ref.generic_types![0]!)]))
      }
  }
  throw new Error(`invalid value for ${ref.type_name}`)
}

function jsonValue(value: unknown): CelInput {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') return new Map(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  throw new Error('context must contain JSON values')
}

/** Conservative resource budget: bounds nested comprehensions before execution. */
function inputSize(value: unknown, depth = 0): number {
  if (depth > 32) throw new Error('condition context nesting limit exceeded')
  if (typeof value === 'string') return value.length + 1
  if (!value || typeof value !== 'object') return 1
  return 1 + Object.values(value).reduce<number>((sum, item) => sum + inputSize(item, depth + 1), 0)
}

function astShape(value: unknown): { nodes: number, loops: number } {
  if (!value || typeof value !== 'object') return { nodes: 0, loops: 0 }
  const obj = value as Record<string, unknown>
  let nodes = 1
  let loops = 0
  for (const child of Object.values(obj)) {
    const shape = astShape(child)
    nodes += shape.nodes
    loops += shape.loops
  }
  return { nodes, loops: loops + (obj.case === 'comprehensionExpr' ? 1 : 0) }
}

interface CompiledCondition {
  definition: Condition
  evaluate: ReturnType<typeof plan>
  nodes: number
  loops: number
}

export class Conditions {
  private readonly compiled = new Map<string, CompiledCondition>()

  constructor(definitions: Record<string, Condition> = {}) {
    for (const [name, definition] of Object.entries(definitions)) {
      try {
        if (!definition || definition.name !== name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid condition name')
        if (typeof definition.expression !== 'string' || definition.expression.length > 65536) throw new Error('invalid condition expression')
        const checker = new Environment({ limits: { maxAstNodes: 10000, maxDepth: 64 } })
          .registerType('IPAddress', { fields: {} })
          .registerOperator('IPAddress == IPAddress', () => false)
          .registerFunction('ipaddress(string): IPAddress', () => { throw new Error('type checking only') })
          .registerFunction('IPAddress.in_cidr(string): bool', () => { throw new Error('type checking only') })
          .registerFunction('string(IPAddress): string', () => { throw new Error('type checking only') })
        const variables: Record<string, CelType> = Object.create(null)
        for (const [key, ref] of Object.entries(definition.parameters ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid parameter name')
          const [checkType, evalType] = parameterType(ref)
          checker.registerVariable(key, checkType)
          variables[key] = evalType
        }
        const checked = checker.check(definition.expression)
        if (!checked.valid || checked.type !== 'bool') throw new Error('condition must be a well-typed boolean expression')
        const ast = parse(definition.expression)
        const environment = celEnv({ variables, funcs, registry: createRegistry(ipRegistry, TimestampSchema, DurationSchema),
          re2: { compile: pattern => { const regex = RE2JS.compile(pattern); return { test: text => regex.matcher(text).find() } } },
        })
        this.compiled.set(name, { definition, evaluate: plan(environment, ast), ...astShape(ast.expr) })
      }
      catch (error) {
        throw new ConditionError(`invalid condition '${name}': ${error instanceof Error ? error.message : 'compilation failed'}`)
      }
    }
  }

  has(name: string): boolean { return this.compiled.has(name) }

  validateContext(condition: RelationshipCondition): void {
    const compiled = this.compiled.get(condition.name)
    if (!compiled) throw new ConditionError(`condition '${condition.name}' is not defined`)
    try {
      if (inputSize(condition.context) > 100000) throw new Error('condition context limit exceeded')
      for (const [key, value] of Object.entries(condition.context ?? {})) {
        const ref = compiled.definition.parameters?.[key]
        if (!ref) throw new Error(`unknown context parameter '${key}'`)
        convert(value, ref)
      }
    }
    catch (error) { throw new ConditionError(`invalid context for '${condition.name}': ${error instanceof Error ? error.message : 'invalid value'}`) }
  }

  evaluate(condition: RelationshipCondition | undefined, context: Record<string, unknown> = {}): boolean {
    if (!condition) return true
    const compiled = this.compiled.get(condition.name)
    if (!compiled) throw new ConditionError(`condition '${condition.name}' is not defined`)
    try {
      const merged = { ...context, ...condition.context }
      const size = inputSize(merged)
      if (size > 100000 || compiled.nodes * Math.max(2, size, compiled.nodes) ** Math.max(1, compiled.loops) > 1000000) throw new Error('condition evaluation budget exceeded')
      const bindings: Record<string, CelInput> = Object.create(null)
      for (const [name, ref] of Object.entries(compiled.definition.parameters ?? {})) {
        if (!Object.hasOwn(merged, name)) throw new Error(`missing context parameter '${name}'`)
        bindings[name] = convert(merged[name], ref)
      }
      const result = compiled.evaluate(bindings)
      if (isCelError(result)) throw result
      if (typeof result !== 'boolean') throw new Error('condition did not return boolean')
      return result
    }
    catch (error) { throw new ConditionError(`condition '${condition.name}' evaluation failed: ${error instanceof Error ? error.message : 'invalid context'}`) }
  }
}
