package provider

import (
	"fmt"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/acctest"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// Acceptance tests create real resources. Run them against a disposable
// workspace:
//
//	TF_ACC=1 NAV_HOST=http://localhost:4000 NAV_TOKEN=nav_... NAV_WORKSPACE=ws_... go test ./internal/provider -run TestAcc -v
//
// TestAccService additionally needs NAV_ACC_REPO (a public Git repository URL).

func TestAccProjectAndEnvironment(t *testing.T) {
	name := acctest.RandomWithPrefix("tfacc")
	cfg := func(project string) string {
		return fmt.Sprintf(`
resource "nav_project" "p" {
  name                 = %q
  initial_environments = ["production"]
}

resource "nav_environment" "staging" {
  project_id = nav_project.p.id
  name       = "staging"
}
`, project)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: cfg(name),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("nav_project.p", "name", name),
					resource.TestCheckResourceAttrSet("nav_project.p", "environment_ids.production"),
					resource.TestCheckResourceAttr("nav_environment.staging", "protected", "false"),
				),
			},
			{
				Config: cfg(name + "-renamed"),
				Check:  resource.TestCheckResourceAttr("nav_project.p", "name", name+"-renamed"),
			},
			{
				ResourceName:            "nav_project.p",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"initial_environments", "environment_ids"},
			},
			{
				ResourceName:      "nav_environment.staging",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

func TestAccEnvGroup(t *testing.T) {
	name := acctest.RandomWithPrefix("tfacc")
	cfg := func(value string) string {
		return fmt.Sprintf(`
resource "nav_env_group" "g" {
  name         = %q
  env_vars     = { LOG_LEVEL = %q }
  secret_files = { "app.json" = "{}" }
}
`, name, value)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: cfg("info"),
				Check:  resource.TestCheckResourceAttr("nav_env_group.g", "env_vars.LOG_LEVEL", "info"),
			},
			{
				Config: cfg("debug"),
				Check:  resource.TestCheckResourceAttr("nav_env_group.g", "env_vars.LOG_LEVEL", "debug"),
			},
			{
				ResourceName:            "nav_env_group.g",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"env_vars", "secret_files"},
			},
		},
	})
}

func TestAccRegistryCredentialAndWebhook(t *testing.T) {
	name := acctest.RandomWithPrefix("tfacc")
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: fmt.Sprintf(`
resource "nav_registry_credential" "r" {
  name     = %[1]q
  registry = "ghcr.io"
  username = "acme"
  password = "not-a-real-token"
}

resource "nav_webhook" "w" {
  name   = %[1]q
  url    = "https://example.com/nav-hook"
  events = ["deploy_live", "deploy_failed"]
}
`, name),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("nav_registry_credential.r", "registry", "ghcr.io"),
					resource.TestCheckResourceAttr("nav_webhook.w", "events.#", "2"),
					resource.TestCheckResourceAttr("nav_webhook.w", "enabled", "true"),
					resource.TestCheckResourceAttrSet("nav_webhook.w", "secret"),
				),
			},
			{
				ResourceName:            "nav_registry_credential.r",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"password"},
			},
			{
				ResourceName:      "nav_webhook.w",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

func TestAccService(t *testing.T) {
	repo := os.Getenv("NAV_ACC_REPO")
	if repo == "" && os.Getenv("TF_ACC") != "" {
		t.Skip("NAV_ACC_REPO is not set")
	}
	name := acctest.RandomWithPrefix("tfacc")
	cfg := func(count int) string {
		return fmt.Sprintf(`
resource "nav_service" "web" {
  name           = %q
  type           = "web"
  repo_url       = %q
  plan           = "starter"
  instance_count = %d
  env_vars       = { GREETING = "hello" }
  auto_deploy    = "off"
}
`, name, repo, count)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: cfg(1),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrSet("nav_service.web", "url"),
					resource.TestCheckResourceAttrSet("nav_service.web", "branch"),
					resource.TestCheckResourceAttr("nav_service.web", "env_vars.GREETING", "hello"),
				),
			},
			{
				Config: cfg(2),
				Check:  resource.TestCheckResourceAttr("nav_service.web", "instance_count", "2"),
			},
			{
				ResourceName:            "nav_service.web",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"env_vars", "status", "internal_address"},
			},
		},
	})
}
