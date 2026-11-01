package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &projectResource{}
	_ resource.ResourceWithConfigure   = &projectResource{}
	_ resource.ResourceWithImportState = &projectResource{}
)

func newProjectResource() resource.Resource { return &projectResource{} }

type projectResource struct{ base }

type projectModel struct {
	ID                  types.String `tfsdk:"id"`
	WorkspaceID         types.String `tfsdk:"workspace_id"`
	Name                types.String `tfsdk:"name"`
	InitialEnvironments types.List   `tfsdk:"initial_environments"`
	EnvironmentIDs      types.Map    `tfsdk:"environment_ids"`
}

func (r *projectResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (r *projectResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A NAV project: a named group of environments that services, databases and Key Value instances can belong to.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"name": schema.StringAttribute{
				MarkdownDescription: "Project name.",
				Required:            true,
			},
			"initial_environments": schema.ListAttribute{
				MarkdownDescription: "Environments created together with the project (NAV defaults to `[\"production\"]`). Only used at creation; " +
					"changing it later forces a new project. Manage further environments with `nav_environment`.",
				ElementType: types.StringType,
				Optional:    true,
				PlanModifiers: []planmodifier.List{
					listplanmodifier.RequiresReplaceIf(func(_ context.Context, req planmodifier.ListRequest, resp *listplanmodifier.RequiresReplaceIfFuncResponse) {
						// After an import the prior value is null; adopting the configured value is not a reason to replace.
						resp.RequiresReplace = !req.StateValue.IsNull()
					}, "Replaces the project when the initial environments change.", "Replaces the project when the initial environments change."),
				},
			},
			"environment_ids": schema.MapAttribute{
				MarkdownDescription: "Map of environment name to environment ID, for every environment of the project.",
				ElementType:         types.StringType,
				Computed:            true,
			},
		},
	}
}

func (r *projectResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (r *projectResource) apply(ctx context.Context, m *projectModel, p *client.Project, diags *diagsT) {
	m.ID = types.StringValue(p.ID)
	if p.WorkspaceID != "" {
		m.WorkspaceID = types.StringValue(p.WorkspaceID)
	}
	m.Name = types.StringValue(p.Name)
	envs := map[string]string{}
	for _, e := range p.Environments {
		envs[e.Name] = e.ID
	}
	m.EnvironmentIDs = mapValue(ctx, envs, diags)
}

func (r *projectResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	var envs []string
	if known(plan.InitialEnvironments) {
		resp.Diagnostics.Append(plan.InitialEnvironments.ElementsAs(ctx, &envs, false)...)
	}
	if resp.Diagnostics.HasError() {
		return
	}
	p, err := r.api().CreateProject(ctx, ws, plan.Name.ValueString(), envs)
	if err != nil {
		apiError(&resp.Diagnostics, "create project", err)
		return
	}
	if p.WorkspaceID == "" {
		p.WorkspaceID = ws
	}
	r.apply(ctx, &plan, p, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *projectResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	p, err := r.api().GetProject(ctx, ws, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read project", err)
		return
	}
	if p.WorkspaceID == "" {
		p.WorkspaceID = ws
	}
	r.apply(ctx, &state, p, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *projectResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !plan.Name.Equal(state.Name) {
		if err := r.api().UpdateProject(ctx, state.ID.ValueString(), plan.Name.ValueString()); err != nil {
			apiError(&resp.Diagnostics, "update project", err)
			return
		}
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	p, err := r.api().GetProject(ctx, ws, state.ID.ValueString())
	if err != nil {
		apiError(&resp.Diagnostics, "read project", err)
		return
	}
	if p.WorkspaceID == "" {
		p.WorkspaceID = ws
	}
	r.apply(ctx, &plan, p, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *projectResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteProject(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete project", err)
	}
}

// ImportState accepts "<project_id>" (provider workspace) or "<workspace_id>/<project_id>".
func (r *projectResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithWorkspace(ctx, r.data, req, resp)
}

// importWithWorkspace sets id and workspace_id from "<id>" or "<workspace_id>/<id>".
func importWithWorkspace(ctx context.Context, data *navData, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	ws, id := splitImportID(req.ID)
	if ws == "" && data != nil {
		ws = data.workspaceID
	}
	if ws == "" {
		resp.Diagnostics.AddError("Missing workspace", "Import with \"<workspace_id>/<id>\" or set the provider's workspace_id.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), id)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace_id"), ws)...)
}
