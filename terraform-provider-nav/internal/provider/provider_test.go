package provider

import (
	"context"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// testAccProtoV6ProviderFactories runs the provider in-process for acceptance tests.
var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"nav": providerserver.NewProtocol6WithError(New("test")()),
}

// testAccPreCheck verifies the environment acceptance tests need. Acceptance
// tests only run with TF_ACC=1 and talk to a real NAV control plane.
func testAccPreCheck(t *testing.T) {
	t.Helper()
	for _, k := range []string{"NAV_HOST", "NAV_TOKEN", "NAV_WORKSPACE"} {
		if os.Getenv(k) == "" {
			t.Fatalf("%s must be set for acceptance tests", k)
		}
	}
}

// TestProviderSchemas runs without TF_ACC: it builds every provider, resource
// and data source schema through the protocol server, which rejects invalid
// schemas (bad defaults, plan modifiers on non-computed attributes, ...).
func TestProviderSchemas(t *testing.T) {
	srv, err := providerserver.NewProtocol6WithError(New("test")())()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range resp.Diagnostics {
		if d.Severity == tfprotov6.DiagnosticSeverityError {
			t.Errorf("schema error: %s: %s", d.Summary, d.Detail)
		}
	}
	wantResources := []string{
		"nav_project", "nav_environment", "nav_service", "nav_custom_domain", "nav_env_group", "nav_postgres",
		"nav_key_value", "nav_registry_credential", "nav_webhook", "nav_log_stream",
	}
	for _, r := range wantResources {
		if _, ok := resp.ResourceSchemas[r]; !ok {
			t.Errorf("missing resource %s", r)
		}
	}
	for _, d := range []string{"nav_workspace", "nav_service", "nav_postgres"} {
		if _, ok := resp.DataSourceSchemas[d]; !ok {
			t.Errorf("missing data source %s", d)
		}
	}
	// Secrets must be marked sensitive.
	sensitive := map[string][]string{
		"nav_service":             {"env_vars", "secret_files", "deploy_hook_url"},
		"nav_env_group":           {"env_vars", "secret_files"},
		"nav_postgres":            {"password", "internal_connection_string", "external_connection_string"},
		"nav_key_value":           {"password", "internal_connection_string", "external_connection_string"},
		"nav_registry_credential": {"password"},
		"nav_webhook":             {"secret"},
		"nav_log_stream":          {"token"},
	}
	for res, attrs := range sensitive {
		s := resp.ResourceSchemas[res]
		if s == nil {
			continue
		}
		for _, name := range attrs {
			found := false
			for _, a := range s.Block.Attributes {
				if a.Name == name {
					found = true
					if !a.Sensitive {
						t.Errorf("%s.%s should be sensitive", res, name)
					}
				}
			}
			if !found {
				t.Errorf("%s has no attribute %s", res, name)
			}
		}
	}
}

func TestSplitImportID(t *testing.T) {
	cases := map[string][2]string{
		"srv_1":       {"", "srv_1"},
		"ws_1/prj_1":  {"ws_1", "prj_1"},
		"srv_1/cdm_2": {"srv_1", "cdm_2"},
	}
	for in, want := range cases {
		p, c := splitImportID(in)
		if p != want[0] || c != want[1] {
			t.Errorf("splitImportID(%q) = %q, %q; want %q, %q", in, p, c, want[0], want[1])
		}
	}
}

func TestEnvVarConversionIsSorted(t *testing.T) {
	vars := toEnvVars(map[string]string{"B": "2", "A": "1"})
	if len(vars) != 2 || vars[0].Key != "A" || vars[1].Key != "B" {
		t.Errorf("toEnvVars = %+v", vars)
	}
	back := fromEnvVars(vars)
	if back["A"] != "1" || back["B"] != "2" {
		t.Errorf("fromEnvVars = %v", back)
	}
}
