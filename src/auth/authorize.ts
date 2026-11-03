/**
 * The OAuth authorization page. This server has exactly one user, the owner,
 * who proves it with OWNER_PASSWORD while approving the client. The consent
 * helpers keep the form unforgeable and unframeable; see
 * node_modules/@cloudflare/workers-oauth-provider/docs/consent-page.md.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const SCOPE = "garmin:read";
export const OWNER_ID = "owner";

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    return request.method === "POST" ? await submit(request, env) : await show(request, env);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return page("No se puede autorizar", escape(error.description), 400);
    if (error instanceof CimdFetchError) return page("No se puede autorizar", "No se ha podido verificar la aplicación.", 400);
    throw error;
  }
}

async function show(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function submit(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
  if (!success) return page("Demasiados intentos", "Espera un minuto y vuelve a intentarlo.", 429);

  if (!(await isOwnerPassword(String(form.get("password") ?? ""), env.OWNER_PASSWORD))) {
    // The handle is still unused, so going back to the form works.
    return page(
      "Contraseña incorrecta",
      '<a href="javascript:history.back()">Vuelve atrás</a> e inténtalo de nuevo.',
      401,
    );
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_ID,
    metadata: {},
    scope: [SCOPE],
    props: {},
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/** Constant-time comparison; hashing first makes both inputs the same length. */
async function isOwnerPassword(candidate: string, expected: string | undefined): Promise<boolean> {
  if (!expected || !candidate) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [candidate, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return crypto.subtle.timingSafeEqual(a!, b!);
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Publicada por <strong>${escape(details.clientDomain)}</strong>.`
    : "La aplicación se ha registrado sola; su nombre no está verificado.";
  const loopback = details.redirectIsLoopback
    ? "<p class=warn>El acceso se enviará a una aplicación de este ordenador. Continúa solo si acabas de iniciar la conexión desde ella.</p>"
    : "";
  return html(
    `Autorizar ${name}`,
    `<h1>¿Dar acceso a ${name}?</h1>
<p>${origin} El acceso se enviará a <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>Podrá <strong>leer</strong> tus datos de Garmin Connect (actividades, sueño, salud). No puede modificar nada.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label>Contraseña del propietario
    <input type="password" name="password" autocomplete="current-password" required autofocus>
  </label>
  <div class=actions>
    <button name="decision" value="approve">Permitir</button>
    <button name="decision" value="deny" formnovalidate class=secondary>Denegar</button>
  </div>
</form>`,
  );
}

function page(title: string, body: string, status: number): Response {
  return new Response(html(escape(title), `<h1>${escape(title)}</h1><p>${body}</p>`), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  label { display: block; margin: 1.5rem 0 1rem; }
  input[type=password] { display: block; width: 100%; box-sizing: border-box; margin-top: .4rem; padding: .6rem; font: inherit; }
  .actions { display: flex; gap: .75rem; }
  button { padding: .6rem 1.2rem; font: inherit; border-radius: .4rem; border: 1px solid; cursor: pointer; }
  .secondary { background: transparent; }
  .warn { padding: .75rem; border-left: 4px solid orange; }
</style>
${body}
</html>`;
}

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
