package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &registryCredentialResource{}
	_ resource.ResourceWithConfigure   = &registryCredentialResource{}
	_ resource.ResourceWithImportState = &registryCredentialResource{}
)

func newRegistryCredentialResource() resource.Resource { return &registryCredentialResource{} }

type registryCredentialResource struct{ base }

type registryCredentialModel struct {
	ID          types.String `tfsdk:"id"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
	Name        types.String `tfsdk:"name"`
	Registry    types.String `tfsdk:"registry"`
	Username    types.String `tfsdk:"username"`
	Password    types.String `tfsdk:"password"`
}

func (r *registryCredentialResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_registry_credential"
}

func (r *registryCredentialResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Credentials for a private container registry, used by image-backed services (`nav_service.registry_credential_id`). " +
			"NAV stores the password encrypted and never returns it, so changes made to it outside Terraform cannot be detected. Requires admin access.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
			},
			"registry": schema.StringAttribute{
				MarkdownDescription: "Lower-case registry host, optionally with a port or path, e.g. `ghcr.io` or `registry.example.com:5000`.",
				Required:            true,
				Validators: []validator.String{
					stringvalidator.RegexMatches(regexp.MustCompile(`^[a-z0-9.-]+(:\d+)?(/[a-z0-9._/-]*)?$`), "must be a lower-case registry host like ghcr.io"),
				},
			},
			"username": schema.StringAttribute{
				MarkdownDescription: "Registry user name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 255)},
			},
			"password": schema.StringAttribute{
				MarkdownDescription: "Password or access token. Write-only on the API side.",
				Required:            true,
				Sensitive:           true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 4096)},
			},
		},
	}
}

func (r *registryCredentialResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (m *registryCredentialModel) fromAPI(c *client.RegistryCredential) {
	m.ID = types.StringValue(c.ID)
	m.WorkspaceID = types.StringValue(c.WorkspaceID)
	m.Name = types.StringValue(c.Name)
	m.Registry = types.StringValue(c.Registry)
	m.Username = types.StringValue(c.Username)
}

func (r *registryCredentialResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan registryCredentialModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	c, err := r.api().CreateRegistryCredential(ctx, ws, client.RegistryCredentialInput{
		Name: strPtr(plan.Name), Registry: strPtr(plan.Registry), Username: strPtr(plan.Username), Password: strPtr(plan.Password),
	})
	if err != nil {
		apiError(&resp.Diagnostics, "create registry credential", err)
		return
	}
	plan.fromAPI(c)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *registryCredentialResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state registryCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	c, err := r.api().GetRegistryCredential(ctx, ws, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read registry credential", err)
		return
	}
	state.fromAPI(c) // the password is kept from state
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *registryCredentialResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state registryCredentialModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in := client.RegistryCredentialInput{Name: strPtr(plan.Name), Registry: strPtr(plan.Registry), Username: strPtr(plan.Username)}
	if !plan.Password.Equal(state.Password) {
		in.Password = strPtr(plan.Password)
	}
	c, err := r.api().UpdateRegistryCredential(ctx, state.ID.ValueString(), in)
	if err != nil {
		apiError(&resp.Diagnostics, "update registry credential", err)
		return
	}
	plan.fromAPI(c)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *registryCredentialResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state registryCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteRegistryCredential(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete registry credential", err)
	}
}

// ImportState accepts "<id>" or "<workspace_id>/<id>". The password cannot be
// imported; Terraform sets it on the next apply.
func (r *registryCredentialResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithWorkspace(ctx, r.data, req, resp)
}
