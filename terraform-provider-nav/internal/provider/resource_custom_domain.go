package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &customDomainResource{}
	_ resource.ResourceWithConfigure   = &customDomainResource{}
	_ resource.ResourceWithImportState = &customDomainResource{}
)

var domainRE = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

func newCustomDomainResource() resource.Resource { return &customDomainResource{} }

type customDomainResource struct{ base }

type customDomainModel struct {
	ID                 types.String `tfsdk:"id"`
	ServiceID          types.String `tfsdk:"service_id"`
	Domain             types.String `tfsdk:"domain"`
	RedirectTo         types.String `tfsdk:"redirect_to"`
	VerificationStatus types.String `tfsdk:"verification_status"`
	CertStatus         types.String `tfsdk:"cert_status"`
	DNSTarget          types.String `tfsdk:"dns_target"`
	DNSRecordType      types.String `tfsdk:"dns_record_type"`
	VerifiedAt         types.String `tfsdk:"verified_at"`
}

func (r *customDomainResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_custom_domain"
}

func (r *customDomainResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A custom domain on a web service or static site. Point a CNAME (or A record for apex domains) at `dns_target`; " +
			"NAV verifies DNS in the background and then issues a TLS certificate. Adding an apex domain (`example.com`) also adds a " +
			"`www.` redirect, which is removed together with it.",
		Attributes: map[string]schema.Attribute{
			"id": idAttribute(),
			"service_id": schema.StringAttribute{
				MarkdownDescription: "Web service or static site the domain routes to. Changing it forces a new domain.",
				Required:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"domain": schema.StringAttribute{
				MarkdownDescription: "Lower-case domain name without a trailing dot, e.g. `app.example.com` or `*.example.com`. Changing it forces a new domain.",
				Required:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Validators: []validator.String{
					stringvalidator.RegexMatches(domainRE, "must be a lower-case domain name such as app.example.com (no trailing dot)"),
				},
			},
			"redirect_to":         schema.StringAttribute{MarkdownDescription: "Domain this one redirects to, if any.", Computed: true},
			"verification_status": schema.StringAttribute{MarkdownDescription: "`unverified`, `verified` or `failed`.", Computed: true},
			"cert_status":         schema.StringAttribute{MarkdownDescription: "`pending`, `issuing`, `issued` or `failed`.", Computed: true},
			"dns_target":          schema.StringAttribute{MarkdownDescription: "Value the DNS record must point to.", Computed: true},
			"dns_record_type":     schema.StringAttribute{MarkdownDescription: "`CNAME` or `A`.", Computed: true},
			"verified_at":         schema.StringAttribute{MarkdownDescription: "When DNS was verified (RFC 3339).", Computed: true},
		},
	}
}

func (r *customDomainResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (m *customDomainModel) fromAPI(d *client.CustomDomain) {
	m.ID = types.StringValue(d.ID)
	m.ServiceID = types.StringValue(d.ServiceID)
	m.Domain = types.StringValue(d.Domain)
	m.RedirectTo = strOrNull(d.RedirectTo)
	m.VerificationStatus = types.StringValue(d.VerificationStatus)
	m.CertStatus = types.StringValue(d.CertStatus)
	m.DNSTarget = types.StringValue(d.DNSTarget)
	m.DNSRecordType = types.StringValue(d.DNSRecordType)
	m.VerifiedAt = strOrNull(d.VerifiedAt)
}

func (r *customDomainResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan customDomainModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.api().CreateCustomDomain(ctx, plan.ServiceID.ValueString(), plan.Domain.ValueString())
	if err != nil {
		apiError(&resp.Diagnostics, "add custom domain", err)
		return
	}
	var d *client.CustomDomain
	for i := range created {
		if created[i].Domain == plan.Domain.ValueString() {
			d = &created[i]
			break
		}
	}
	if d == nil {
		resp.Diagnostics.AddError("Unexpected API response", "NAV did not return the custom domain it created.")
		return
	}
	if d.ServiceID == "" {
		d.ServiceID = plan.ServiceID.ValueString()
	}
	plan.fromAPI(d)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *customDomainResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state customDomainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	d, err := r.api().GetCustomDomain(ctx, state.ServiceID.ValueString(), state.ID.ValueString())
	if client.IsNotFound(err) { // the domain, or its whole service, is gone
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read custom domain", err)
		return
	}
	if d.ServiceID == "" {
		d.ServiceID = state.ServiceID.ValueString()
	}
	state.fromAPI(d)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

// Update has nothing to change: the configurable attributes force replacement.
func (r *customDomainResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan customDomainModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *customDomainResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state customDomainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteCustomDomain(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete custom domain", err)
	}
}

// ImportState takes "<service_id>/<custom_domain_id>" (the API looks domains up per service).
func (r *customDomainResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	svc, id := splitImportID(req.ID)
	if svc == "" || id == "" {
		resp.Diagnostics.AddError("Invalid import ID", "Expected \"<service_id>/<custom_domain_id>\".")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), id)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("service_id"), svc)...)
}
