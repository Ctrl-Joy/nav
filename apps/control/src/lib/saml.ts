// SAML 2.0 service provider. Signature checks, audience, timestamps and InResponseTo are done by @node-saml/node-saml
// (xml-crypto underneath); this module adds the checks it leaves to the caller (issuer, Destination, Recipient) and
// the per-org configuration plumbing. No database access here, so it can be tested on its own.
import { X509Certificate, randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile as SamlProfile } from '@node-saml/node-saml';
import { config } from '@nav/shared/config';

export const CLOCK_SKEW_MS = 90_000;
export const REQUEST_TTL_MS = 10 * 60_000;

const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

export interface IdpSettings {
  entityId: string;
  ssoUrl: string;
  certs: string[];
  binding: 'redirect' | 'post';
}

export interface SpSettings {
  entityId: string;
  acsUrl: string;
  cert: string;
  key: string;
}

export interface SamlUser {
  nameId: string;
  nameIdFormat: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  sessionIndex: string | null;
}

export class SamlError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const spEntityId = (orgId: string) => `${config.apiPublicUrl}/api/v1/auth/saml/${orgId}/metadata`;
export const acsUrl = (orgId: string) => `${config.apiPublicUrl}/api/v1/auth/saml/${orgId}/acs`;
export const loginUrl = (orgId: string) => `${config.apiPublicUrl}/api/v1/auth/saml/${orgId}/login`;

/** Accepts a PEM or bare base64 certificate; returns a normalized PEM, or throws when it is not an X.509 certificate. */
export function normalizeCert(input: string): string {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new SamlError('bad_certificate', 'the signing certificate is not a PEM or base64 X.509 certificate');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  try {
    new X509Certificate(pem);
  } catch {
    throw new SamlError('bad_certificate', 'the signing certificate could not be parsed');
  }
  return pem;
}

export function certInfo(pem: string): { subject: string; notAfter: string; fingerprint256: string } {
  const c = new X509Certificate(pem);
  return { subject: c.subject, notAfter: new Date(c.validTo).toISOString(), fingerprint256: c.fingerprint256 };
}

function parseXml(xml: string): Document {
  if (/<!DOCTYPE/i.test(xml)) throw new SamlError('bad_xml', 'XML with a DOCTYPE is not accepted');
  // Any parse error means we refuse the document rather than work on xmldom's best-effort recovery.
  let failed = '';
  const fail = (msg: string) => { failed ||= msg; };
  const doc = new DOMParser({ errorHandler: { error: fail, fatalError: fail } }).parseFromString(xml, 'text/xml') as unknown as Document;
  if (failed || !doc?.documentElement) throw new SamlError('bad_xml', `not well-formed XML${failed ? `: ${String(failed).split('\n')[0]}` : ''}`);
  return doc;
}

function httpsUrl(u: string, what: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new SamlError('bad_url', `${what} is not a URL`);
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new SamlError('bad_url', `${what} must use HTTPS`);
  return url.toString();
}

/** Reads the IdP's entity id, single sign-on URL (redirect binding preferred) and signing certificates. */
export function parseIdpMetadata(xml: string): IdpSettings {
  const doc = parseXml(xml.trim());
  const root = doc.documentElement;
  const entity = root.localName === 'EntityDescriptor' ? root : (Array.from(root.getElementsByTagNameNS(NS_MD, 'EntityDescriptor'))[0] as Element | undefined);
  if (!entity) throw new SamlError('bad_metadata', 'no EntityDescriptor found in the metadata');
  const idp = Array.from(entity.getElementsByTagNameNS(NS_MD, 'IDPSSODescriptor'))[0] as Element | undefined;
  if (!idp) throw new SamlError('bad_metadata', 'the metadata has no IDPSSODescriptor');
  const entityId = entity.getAttribute('entityID') ?? '';
  if (!entityId) throw new SamlError('bad_metadata', 'the metadata has no entityID');
  const services = Array.from(idp.getElementsByTagNameNS(NS_MD, 'SingleSignOnService')) as Element[];
  const redirect = services.find((s) => s.getAttribute('Binding') === BINDING_REDIRECT);
  const post = services.find((s) => s.getAttribute('Binding') === BINDING_POST);
  const sso = redirect ?? post;
  if (!sso?.getAttribute('Location')) throw new SamlError('bad_metadata', 'the metadata has no HTTP-Redirect or HTTP-POST SingleSignOnService');
  const certs: string[] = [];
  for (const kd of Array.from(idp.getElementsByTagNameNS(NS_MD, 'KeyDescriptor')) as Element[]) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const c of Array.from(kd.getElementsByTagNameNS(NS_DS, 'X509Certificate')) as Element[]) {
      const pem = normalizeCert(c.textContent ?? '');
      if (!certs.includes(pem)) certs.push(pem);
    }
  }
  if (!certs.length) throw new SamlError('bad_metadata', 'the metadata has no signing certificate');
  return { entityId, ssoUrl: httpsUrl(sso.getAttribute('Location')!, 'the SSO URL'), certs, binding: redirect ? 'redirect' : 'post' };
}

/** Validates manually entered IdP settings. */
export function idpFromFields(f: { entityId: string; ssoUrl: string; certificate: string; binding?: 'redirect' | 'post' }): IdpSettings {
  if (!f.entityId.trim()) throw new SamlError('bad_entity_id', 'the IdP entity ID is required');
  return { entityId: f.entityId.trim(), ssoUrl: httpsUrl(f.ssoUrl.trim(), 'the SSO URL'), certs: [normalizeCert(f.certificate)], binding: f.binding ?? 'redirect' };
}

/** A self-signed certificate for signing AuthnRequests (IdPs pin it from our metadata). */
export async function generateSpKeyPair(commonName: string): Promise<{ cert: string; key: string }> {
  const forge = (await import('node-forge')).default;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000);
  const attrs = [{ name: 'commonName', value: commonName.slice(0, 64) }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** Request ids are XML IDs: they must not start with a digit. */
export const newRequestId = () => `_nav${randomBytes(20).toString('hex')}`;

/** A cache that knows exactly one outstanding request: the one this response must answer. */
function singleRequestCache(requestId: string | null, createdAt: Date): CacheProvider {
  let live = requestId;
  return {
    saveAsync: async (key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (key && key === live ? createdAt.toISOString() : null),
    removeAsync: async (key) => {
      if (key && key === live) live = null;
      return key;
    },
  };
}

function client(idp: IdpSettings, sp: SpSettings, requestId: string | null, requestCreatedAt = new Date()): SAML {
  return new SAML({
    issuer: sp.entityId,
    audience: sp.entityId,
    callbackUrl: sp.acsUrl,
    entryPoint: idp.ssoUrl,
    idpCert: idp.certs,
    privateKey: sp.key,
    publicCert: sp.cert,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    authnRequestBinding: idp.binding === 'post' ? 'HTTP-POST' : 'HTTP-Redirect',
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    disableRequestedAuthnContext: true,
    // Either the Response or the Assertion must carry a valid signature from one of the IdP's certificates.
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: 0,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: singleRequestCache(requestId, requestCreatedAt),
    generateUniqueId: () => requestId ?? newRequestId(),
  });
}

/** Builds the AuthnRequest for `requestId`: a signed redirect URL, or an auto-submitting HTML form for HTTP-POST. */
export async function authnRequest(idp: IdpSettings, sp: SpSettings, requestId: string, relayState: string): Promise<{ redirect: string } | { form: string }> {
  const saml = client(idp, sp, requestId);
  if (idp.binding === 'post') return { form: await saml.getAuthorizeFormAsync(relayState) };
  return { redirect: await saml.getAuthorizeUrlAsync(relayState, undefined, {}) };
}

export function spMetadata(sp: SpSettings): string {
  const saml = new SAML({ issuer: sp.entityId, callbackUrl: sp.acsUrl, idpCert: 'unused', privateKey: sp.key, publicCert: sp.cert, identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', wantAssertionsSigned: false });
  return saml.generateServiceProviderMetadata(null, sp.cert);
}

/** The InResponseTo of a base64 SAMLResponse (read the same way node-saml reads it), or null. */
export function responseInResponseTo(samlResponse: string): string | null {
  const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  const root = parseXml(xml).documentElement;
  if (root.localName !== 'Response') throw new SamlError('bad_response', 'not a SAML Response');
  return root.getAttribute('InResponseTo') || null;
}

const EMAIL_ATTRS = ['email', 'mail', 'emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'user.email'];
const GIVEN_ATTRS = ['firstname', 'givenname', 'first_name', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const FAMILY_ATTRS = ['lastname', 'surname', 'sn', 'last_name', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
const NAME_ATTRS = ['displayname', 'name', 'urn:oid:2.16.840.1.113730.3.1.241', 'http://schemas.microsoft.com/identity/claims/displayname'];

function attr(profile: SamlProfile, names: string[]): string | null {
  for (const [k, v] of Object.entries(profile)) {
    if (!names.includes(k.toLowerCase())) continue;
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Validates a POSTed SAMLResponse against the IdP settings. `requestId` is the AuthnRequest the caller already
 * consumed from its store; the response (and its subject confirmation) must answer exactly that request.
 */
export async function validateResponse(opts: { idp: IdpSettings; sp: SpSettings; samlResponse: string; requestId: string; requestCreatedAt?: Date }): Promise<SamlUser> {
  const { idp, sp } = opts;
  const xml = Buffer.from(opts.samlResponse, 'base64').toString('utf8');
  const root = parseXml(xml).documentElement;
  if (root.localName !== 'Response') throw new SamlError('bad_response', 'not a SAML Response');
  if (root.getAttribute('InResponseTo') !== opts.requestId) throw new SamlError('bad_in_response_to', 'the response does not answer this sign-in request');
  const destination = root.getAttribute('Destination');
  if (destination && destination !== sp.acsUrl) throw new SamlError('bad_destination', 'the response was sent to a different service provider URL');

  let profile: SamlProfile | null;
  try {
    ({ profile } = await client(idp, sp, opts.requestId, opts.requestCreatedAt).validatePostResponseAsync({ SAMLResponse: opts.samlResponse }));
  } catch (err) {
    throw new SamlError('invalid_response', (err as Error).message);
  }
  if (!profile) throw new SamlError('invalid_response', 'the response carries no assertion');
  if (profile.issuer !== idp.entityId) throw new SamlError('bad_issuer', 'the assertion was issued by a different identity provider');

  // Recipient lives in the signed assertion: node-saml hands back exactly the XML it verified.
  const assertionXml = profile.getAssertionXml?.();
  if (!assertionXml) throw new SamlError('invalid_response', 'no signed assertion');
  const confirmations = Array.from(parseXml(assertionXml).getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'SubjectConfirmationData')) as Element[];
  if (!confirmations.length || confirmations.some((c) => c.getAttribute('Recipient') !== sp.acsUrl)) {
    throw new SamlError('bad_recipient', 'the assertion is addressed to a different recipient');
  }

  const nameId = profile.nameID;
  if (!nameId) throw new SamlError('no_subject', 'the assertion has no NameID');
  const email = attr(profile, EMAIL_ATTRS) ?? (looksLikeEmail(nameId) ? nameId : null);
  return {
    nameId,
    nameIdFormat: profile.nameIDFormat ?? null,
    email: email && looksLikeEmail(email) ? email.toLowerCase() : null,
    firstName: attr(profile, GIVEN_ATTRS),
    lastName: attr(profile, FAMILY_ATTRS),
    displayName: attr(profile, NAME_ATTRS),
    sessionIndex: profile.sessionIndex ?? null,
  };
}
