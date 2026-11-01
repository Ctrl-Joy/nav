package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &envGroupResource{}
	_ resource.ResourceWithConfigure   = &envGroupResource{}
	_ resource.ResourceWithImportState = &envGroupResource{}
)

func newEnvGroupResource() resource.Resource { return &envGroupResource{} }

type envGroupResource struct{ base }

type envGroupModel struct {
	ID          types.String `tfsdk:"id"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
	Name        types.String `tfsdk:"name"`
	EnvVars     types.Map    `tfsdk:"env_vars"`
	SecretFiles types.Map    `tfsdk:"secret_files"`
}

func (r *envGroupResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_env_group"
}

func (r *envGroupResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A shared group of environment variables and secret files that services link to with `nav_service.env_group_ids`. " +
			"Changing the variables or files redeploys every linked live service.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"name": schema.StringAttribute{
				MarkdownDescription: "Group name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 100)},
			},
			"env_vars": schema.MapAttribute{
				MarkdownDescription: "Variables, as a map of name to value. Managed as a full set when present; left unmanaged when omitted. Sensitive.",
				ElementType:         types.StringType,
				Optional:            true,
				Sensitive:           true,
			},
			"secret_files": schema.MapAttribute{
				MarkdownDescription: "Secret files, as a map of file name to content. Managed like `env_vars`. Sensitive.",
				ElementType:         types.StringType,
				Optional:            true,
				Sensitive:           true,
			},
		},
	}
}

func (r *envGroupResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (r *envGroupResource) apply(ctx context.Context, m *envGroupModel, g *client.EnvGroup, diags *diagsT) {
	m.ID = types.StringValue(g.ID)
	m.WorkspaceID = types.StringValue(g.WorkspaceID)
	m.Name = types.StringValue(g.Name)
	if !m.EnvVars.IsNull() {
		m.EnvVars = mapValue(ctx, fromEnvVars(g.EnvVars), diags)
	}
	if !m.SecretFiles.IsNull() {
		m.SecretFiles = mapValue(ctx, fromSecretFiles(g.SecretFiles), diags)
	}
}

func (r *envGroupResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan envGroupModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	vars := stringMap(ctx, plan.EnvVars, &resp.Diagnostics)
	files := stringMap(ctx, plan.SecretFiles, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	g, err := r.api().CreateEnvGroup(ctx, ws, client.CreateEnvGroupInput{
		Name:        plan.Name.ValueString(),
		EnvVars:     toEnvVars(vars),
		SecretFiles: toSecretFiles(files),
	})
	if err != nil {
		apiError(&resp.Diagnostics, "create env group", err)
		return
	}
	r.apply(ctx, &plan, g, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *envGroupResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state envGroupModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	g, err := r.api().GetEnvGroup(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read env group", err)
		return
	}
	r.apply(ctx, &state, g, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *envGroupResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state envGroupModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in := client.UpdateEnvGroupInput{}
	if !plan.Name.Equal(state.Name) {
		in.Name = strPtr(plan.Name)
	}
	if !plan.EnvVars.Equal(state.EnvVars) {
		vars := toEnvVars(stringMap(ctx, plan.EnvVars, &resp.Diagnostics)) // null -> [] clears
		in.EnvVars = &vars
	}
	if !plan.SecretFiles.Equal(state.SecretFiles) {
		files := toSecretFiles(stringMap(ctx, plan.SecretFiles, &resp.Diagnostics))
		in.SecretFiles = &files
	}
	if resp.Diagnostics.HasError() {
		return
	}
	g, err := r.api().UpdateEnvGroup(ctx, state.ID.ValueString(), in)
	if err != nil {
		apiError(&resp.Diagnostics, "update env group", err)
		return
	}
	r.apply(ctx, &plan, g, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *envGroupResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state envGroupModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteEnvGroup(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete env group", err)
	}
}

// ImportState takes the env group ID. Use env_vars / secret_files in the
// configuration to adopt the group's contents.
func (r *envGroupResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
