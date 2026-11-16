package external

import (
	"os"
	"testing"

	"github.com/openfga/openfga/tests/check"
	"github.com/openfga/openfga/tests/listobjects"
	"github.com/openfga/openfga/tests/listusers"
)

func enabled(name string) bool {
	want := os.Getenv("CONF_SUITES") // comma list, empty = all
	if want == "" {
		return true
	}
	for _, s := range splitComma(want) {
		if s == name {
			return true
		}
	}
	return false
}

func splitComma(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	return append(out, cur)
}

func TestExternalCheckAll(t *testing.T) {
	if !enabled("check") {
		t.Skip()
	}
	check.RunAllTests(t, NewHTTPClient())
}

func TestExternalListObjectsAll(t *testing.T) {
	if !enabled("listobjects") {
		t.Skip()
	}
	listobjects.RunAllTests(t, NewHTTPClient())
}

func TestExternalListUsersAll(t *testing.T) {
	if !enabled("listusers") {
		t.Skip()
	}
	listusers.RunAllTests(t, NewHTTPClient())
}

func TestExternalCheckMatrix(t *testing.T) {
	if !enabled("check-matrix") {
		t.Skip()
	}
	check.RunMatrixTests(t, "external", "external", NewHTTPClient())
}

func TestExternalListObjectsMatrix(t *testing.T) {
	if !enabled("listobjects-matrix") {
		t.Skip()
	}
	listobjects.RunMatrixTests(t, "external", "external", NewHTTPClient())
}
