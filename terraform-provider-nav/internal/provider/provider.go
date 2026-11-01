// Package provider implements the NAV Terraform provider with the Terraform Plugin Framework.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

const defaultHost = "http://localhost:4000"

var _ provider.Provider = &navProvider{}

type navProvider struct {
	version string
}

// New returns a constructor for the provider, as providerserver expects.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &navProvider{version: version} }
}

type navProviderModel struct {
	Host        types.String `tfsdk:"host"`
	APIKey      types.String `tfsdk:"api_key"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
}

// navData is handed to every resource and data source.
type navData struct {
	client      *client.Client
	workspaceID string
}

func (p *navProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "nav"
	resp.Version = p.version
}

func (p *navProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manage [NAV](https://github.com/Ctrl-Joy/nav) projects, services, databases and related resources through the NAV REST API.",
		Attributes: map[string]schema.Attribute{
			"host": schema.StringAttribute{
				MarkdownDescription: "Base URL of the NAV control plane, e.g. `https://nav.example.com`. `/api/v1` is appended automatically. Defaults to the `NAV_HOST` environment variable, then `" + defaultHost + "`.",
				Optional:            true,
			},
			"api_key": schema.StringAttribute{
				MarkdownDescription: "NAV API key (`nav_...`), created under Account settings or with `POST /api/v1/api-keys`. Defaults to the `NAV_TOKEN` environment variable.",
				Optional:            true,
				Sensitive:           true,
			},
			"workspace_id": schema.StringAttribute{
				MarkdownDescription: "Default workspace for resources that do not set `workspace_id`. Defaults to the `NAV_WORKSPACE` environment variable.",
				Optional:            true,
			},
		},
	}
}

func (p *navProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg navProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for attr, v := range map[string]types.String{"host": cfg.Host, "api_key": cfg.APIKey, "workspace_id": cfg.WorkspaceID} {
		if v.IsUnknown() {
			resp.Diagnostics.AddAttributeError(path.Root(attr), "Unknown provider configuration value",
				"The provider cannot be configured with a value that is only known after apply. Set it statically or through its environment variable.")
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}

	host := firstNonEmpty(cfg.Host.ValueString(), os.Getenv("NAV_HOST"), defaultHost)
	apiKey := firstNonEmpty(cfg.APIKey.ValueString(), os.Getenv("NAV_TOKEN"))
	workspaceID := firstNonEmpty(cfg.WorkspaceID.ValueString(), os.Getenv("NAV_WORKSPACE"))

	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"), "Missing NAV API key",
			"Set api_key in the provider block or the NAV_TOKEN environment variable to a NAV API key (nav_...).")
		return
	}

	c, err := client.New(host, apiKey, client.WithUserAgent("terraform-provider-nav/"+p.version))
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("host"), "Invalid NAV host", err.Error())
		return
	}
	ctx = tflog.SetField(ctx, "nav_host", c.BaseURL())
	tflog.Debug(ctx, "configured NAV client")

	data := &navData{client: c, workspaceID: workspaceID}
	resp.DataSourceData = data
	resp.ResourceData = data
}

func (p *navProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		newProjectResource,
		newEnvironmentResource,
		newServiceResource,
		newCustomDomainResource,
		newEnvGroupResource,
		newPostgresResource,
		newKeyValueResource,
		newRegistryCredentialResource,
		newWebhookResource,
		newLogStreamResource,
	}
}

func (p *navProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		newWorkspaceDataSource,
		newServiceDataSource,
		newPostgresDataSource,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
