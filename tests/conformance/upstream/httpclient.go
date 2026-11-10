// Package external drives the upstream OpenFGA query test suites (check, list-objects,
// list-users) against any OpenFGA-compatible HTTP server. It is copied into an upstream
// checkout (see ../run-upstream.sh) because the suites use internal packages.
package external

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	openfgav1 "github.com/openfga/api/proto/openfga/v1"
)

// HTTPClient implements tests.ClientInterface over the OpenFGA REST API.
type HTTPClient struct {
	base string
	http *http.Client
}

func NewHTTPClient() *HTTPClient {
	base := os.Getenv("CONF_TARGET_URL")
	if base == "" {
		panic("CONF_TARGET_URL is required")
	}
	tr := &http.Transport{MaxIdleConns: 256, MaxIdleConnsPerHost: 256, MaxConnsPerHost: 256}
	return &HTTPClient{base: strings.TrimRight(base, "/"), http: &http.Client{Transport: tr, Timeout: 120 * time.Second}}
}

// With CONF_NORMALIZE_TIMESTAMPS=1, "YYYY-MM-DD HH:MM:SS[.ffffff]+00" timestamps in responses are
// rewritten to RFC 3339 so strict protobuf JSON parsing can proceed; used only to measure
// behaviour behind the timestamp-format defect, never for the strict run.
var sqlTimestamp = regexp.MustCompile(`"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00"`)

func normalize(body []byte) []byte {
	if os.Getenv("CONF_NORMALIZE_TIMESTAMPS") != "1" {
		return body
	}
	return sqlTimestamp.ReplaceAll(body, []byte(`"${1}T${2}Z"`))
}

var marshal = protojson.MarshalOptions{UseProtoNames: true}
var unmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}

func errorCode(name string) (int32, bool) {
	if v, ok := openfgav1.ErrorCode_value[name]; ok {
		return v, true
	}
	if v, ok := openfgav1.InternalErrorCode_value[name]; ok {
		return v, true
	}
	if v, ok := openfgav1.NotFoundErrorCode_value[name]; ok {
		return v, true
	}
	if v, ok := openfgav1.UnprocessableContentErrorCode_value[name]; ok {
		return v, true
	}
	return 0, false
}

func toStatus(httpStatus int, body []byte) error {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Wrapped *struct {
			Code    int32  `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	// The upstream REST gateway renders errors on the streaming endpoint as
	// {"error":{"code":<grpc code>,"message":...}} and cannot carry the OpenFGA code.
	// gRPC InvalidArgument (3) is how OpenFGA reports validation_error (2000); map it so
	// the control server is comparable. Other wrapped codes are passed through unchanged.
	if e.Wrapped != nil && e.Code == "" {
		if e.Wrapped.Code == 3 {
			return status.Error(codes.Code(2000), e.Wrapped.Message)
		}
		return status.Error(codes.Code(e.Wrapped.Code), e.Wrapped.Message)
	}
	if n, ok := errorCode(e.Code); ok {
		return status.Error(codes.Code(n), e.Message)
	}
	return status.Error(codes.Unknown, fmt.Sprintf("http %d code=%q body=%s", httpStatus, e.Code, string(body)))
}

func (c *HTTPClient) do(ctx context.Context, path string, in proto.Message, out proto.Message) error {
	var payload []byte
	if in != nil {
		var err error
		payload, err = marshal.Marshal(in)
		if err != nil {
			return err
		}
	}
	// The published wire format spells these two userset keys in camelCase (the server's own
	// responses do), while protojson with proto names emits snake_case. Send the published form.
	payload = bytes.ReplaceAll(payload, []byte(`"computed_userset"`), []byte(`"computedUserset"`))
	payload = bytes.ReplaceAll(payload, []byte(`"tuple_to_userset"`), []byte(`"tupleToUserset"`))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return status.Error(codes.Unavailable, err.Error())
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		if os.Getenv("CONF_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "CONF_DEBUG %s -> %d\nREQ %s\nRES %s\n", path, resp.StatusCode, payload, body)
		}
		return toStatus(resp.StatusCode, body)
	}
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	return unmarshal.Unmarshal(normalize(body), out)
}

func (c *HTTPClient) CreateStore(ctx context.Context, in *openfgav1.CreateStoreRequest, _ ...grpc.CallOption) (*openfgav1.CreateStoreResponse, error) {
	out := &openfgav1.CreateStoreResponse{}
	return out, c.do(ctx, "/stores", in, out)
}

func (c *HTTPClient) WriteAuthorizationModel(ctx context.Context, in *openfgav1.WriteAuthorizationModelRequest, _ ...grpc.CallOption) (*openfgav1.WriteAuthorizationModelResponse, error) {
	out := &openfgav1.WriteAuthorizationModelResponse{}
	return out, c.do(ctx, "/stores/"+in.GetStoreId()+"/authorization-models", in, out)
}

func (c *HTTPClient) Write(ctx context.Context, in *openfgav1.WriteRequest, _ ...grpc.CallOption) (*openfgav1.WriteResponse, error) {
	out := &openfgav1.WriteResponse{}
	return out, c.do(ctx, "/stores/"+in.GetStoreId()+"/write", in, out)
}

func (c *HTTPClient) Check(ctx context.Context, in *openfgav1.CheckRequest, _ ...grpc.CallOption) (*openfgav1.CheckResponse, error) {
	out := &openfgav1.CheckResponse{}
	return out, c.do(ctx, "/stores/"+in.GetStoreId()+"/check", in, out)
}

func (c *HTTPClient) ListUsers(ctx context.Context, in *openfgav1.ListUsersRequest, _ ...grpc.CallOption) (*openfgav1.ListUsersResponse, error) {
	out := &openfgav1.ListUsersResponse{}
	return out, c.do(ctx, "/stores/"+in.GetStoreId()+"/list-users", in, out)
}

func (c *HTTPClient) ListObjects(ctx context.Context, in *openfgav1.ListObjectsRequest, _ ...grpc.CallOption) (*openfgav1.ListObjectsResponse, error) {
	out := &openfgav1.ListObjectsResponse{}
	return out, c.do(ctx, "/stores/"+in.GetStoreId()+"/list-objects", in, out)
}

type streamClient struct {
	grpc.ClientStream
	body io.Closer
	sc   *bufio.Scanner
	err  error // deferred open error, delivered by the first Recv like a gRPC stream
}

func (s *streamClient) Recv() (*openfgav1.StreamedListObjectsResponse, error) {
	if s.err != nil {
		return nil, s.err
	}
	for s.sc.Scan() {
		line := bytes.TrimSpace(s.sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var env struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int32  `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(line, &env); err != nil {
			return nil, status.Error(codes.Unknown, err.Error())
		}
		if env.Error != nil {
			return nil, status.Error(codes.Code(env.Error.Code), env.Error.Message)
		}
		out := &openfgav1.StreamedListObjectsResponse{}
		if err := unmarshal.Unmarshal(env.Result, out); err != nil {
			return nil, err
		}
		return out, nil
	}
	_ = s.body.Close()
	if err := s.sc.Err(); err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	return nil, io.EOF
}

func (c *HTTPClient) StreamedListObjects(ctx context.Context, in *openfgav1.StreamedListObjectsRequest, _ ...grpc.CallOption) (openfgav1.OpenFGAService_StreamedListObjectsClient, error) {
	payload, err := marshal.Marshal(in)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/stores/"+in.GetStoreId()+"/streamed-list-objects", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		err := toStatus(resp.StatusCode, body)
		if bytes.Contains(body, []byte(`"error":{"code"`)) {
			// Gateway-style wrapped error: recover the specific OpenFGA error code by replaying
			// the request on the unary endpoint, which returns {"code": "<name>"} bodies.
			unary := &openfgav1.ListObjectsResponse{}
			if uerr := c.do(ctx, "/stores/"+in.GetStoreId()+"/list-objects", &openfgav1.ListObjectsRequest{
				StoreId: in.GetStoreId(), AuthorizationModelId: in.GetAuthorizationModelId(), Type: in.GetType(),
				Relation: in.GetRelation(), User: in.GetUser(), ContextualTuples: in.GetContextualTuples(), Context: in.GetContext(),
				Consistency: in.GetConsistency(),
			}, unary); uerr != nil {
				err = uerr
			}
		}
		return &streamClient{body: http.NoBody, err: err}, nil
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	return &streamClient{body: resp.Body, sc: sc}, nil
}
