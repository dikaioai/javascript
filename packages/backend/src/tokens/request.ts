import type { Match, MatchFunction } from '@clerk/shared/pathToRegexp';
import { match } from '@clerk/shared/pathToRegexp';
import type { JwtPayload } from '@clerk/types';

import type { ApiClient } from '../api';
import { constants } from '../constants';
import type { TokenCarrier } from '../errors';
import { TokenVerificationError, TokenVerificationErrorReason } from '../errors';
import { decodeJwt } from '../jwt/verifyJwt';
import { assertValidSecretKey } from '../util/optionsAssertions';
import { isDevelopmentFromSecretKey } from '../util/shared';
import type { AuthenticateContext } from './authenticateContext';
import { createAuthenticateContext } from './authenticateContext';
import type { SignedInAuthObject } from './authObjects';
import type { HandshakeState, RequestState, SignedInState, SignedOutState } from './authStatus';
import { AuthErrorReason, handshake, signedIn, signedOut } from './authStatus';
import { createClerkRequest } from './clerkRequest';
import { getCookieName, getCookieValue } from './cookie';
import { verifyHandshakeToken } from './handshake';
import type { AuthenticateRequestOptions, OrganizationSyncOptions } from './types';
import { verifyToken } from './verify';

function assertSignInUrlExists(signInUrl: string | undefined, key: string): asserts signInUrl is string {
  if (!signInUrl && isDevelopmentFromSecretKey(key)) {
    throw new Error(`Missing signInUrl. Pass a signInUrl for dev instances if an app is satellite`);
  }
}

function assertProxyUrlOrDomain(proxyUrlOrDomain: string | undefined) {
  if (!proxyUrlOrDomain) {
    throw new Error(`Missing domain and proxyUrl. A satellite application needs to specify a domain or a proxyUrl`);
  }
}

function assertSignInUrlFormatAndOrigin(_signInUrl: string, origin: string) {
  let signInUrl: URL;
  try {
    signInUrl = new URL(_signInUrl);
  } catch {
    throw new Error(`The signInUrl needs to have a absolute url format.`);
  }

  if (signInUrl.origin === origin) {
    throw new Error(`The signInUrl needs to be on a different origin than your satellite application.`);
  }
}

function assertApiClient(apiClient: ApiClient | undefined): asserts apiClient is ApiClient {
  if (!apiClient) {
    throw new Error(`Missing apiClient. An apiClient is needed to perform token refresh.`);
  }
}

/**
 * Currently, a request is only eligible for a handshake if we can say it's *probably* a request for a document, not a fetch or some other exotic request.
 * This heuristic should give us a reliable enough signal for browsers that support `Sec-Fetch-Dest` and for those that don't.
 */
function isRequestEligibleForHandshake(authenticateContext: { secFetchDest?: string; accept?: string }) {
  const { accept, secFetchDest } = authenticateContext;

  // NOTE: we could also check sec-fetch-mode === navigate here, but according to the spec, sec-fetch-dest: document should indicate that the request is the data of a user navigation.
  // Also, we check for 'iframe' because it's the value set when a doc request is made by an iframe.
  if (secFetchDest === 'document' || secFetchDest === 'iframe') {
    return true;
  }

  if (!secFetchDest && accept?.startsWith('text/html')) {
    return true;
  }

  return false;
}

function isRequestEligibleForRefresh(
  err: TokenVerificationError,
  authenticateContext: { refreshTokenInCookie?: string },
  request: Request,
) {
  return (
    err.reason === TokenVerificationErrorReason.TokenExpired &&
    !!authenticateContext.refreshTokenInCookie &&
    request.method === 'GET'
  );
}

export async function authenticateRequest(
  request: Request,
  options: AuthenticateRequestOptions,
): Promise<RequestState> {
  const authenticateContext = await createAuthenticateContext(createClerkRequest(request), options);
  assertValidSecretKey(authenticateContext.secretKey);

  if (authenticateContext.isSatellite) {
    assertSignInUrlExists(authenticateContext.signInUrl, authenticateContext.secretKey);
    if (authenticateContext.signInUrl && authenticateContext.origin) {
      assertSignInUrlFormatAndOrigin(authenticateContext.signInUrl, authenticateContext.origin);
    }
    assertProxyUrlOrDomain(authenticateContext.proxyUrl || authenticateContext.domain);
  }

  function removeDevBrowserFromURL(url: URL) {
    const updatedURL = new URL(url);

    updatedURL.searchParams.delete(constants.QueryParameters.DevBrowser);
    // Remove legacy dev browser query param key to support local app with v5 using AP with v4
    updatedURL.searchParams.delete(constants.QueryParameters.LegacyDevBrowser);

    return updatedURL;
  }

  function buildRedirectToHandshake({
    requestURL,
    handshakeReason,
    refreshError,
  }: {
    requestURL: URL;
    handshakeReason: AuthErrorReason;
    refreshError: string;
  }) {
    const redirectUrl = removeDevBrowserFromURL(authenticateContext.clerkUrl);
    const frontendApiNoProtocol = authenticateContext.frontendApi.replace(/http(s)?:\/\//, '');

    const url = new URL(`https://${frontendApiNoProtocol}/v1/client/handshake`);
    url.searchParams.append('redirect_url', redirectUrl?.href || '');
    url.searchParams.append('suffixed_cookies', authenticateContext.suffixedCookies.toString());
    url.searchParams.append(constants.QueryParameters.HandshakeReason, handshakeReason);
    url.searchParams.append(constants.QueryParameters.RefreshTokenError, refreshError);

    if (authenticateContext.instanceType === 'development' && authenticateContext.devBrowserToken) {
      url.searchParams.append(constants.QueryParameters.DevBrowser, authenticateContext.devBrowserToken);
    }

    const toActivate = getOrganizationSyncTarget(requestURL, options.organizationSyncOptions);
    if (toActivate) {
      const params = getOrganizationSyncQueryParams(toActivate);

      params.forEach((value, key) => {
        url.searchParams.append(key, value);
      });
    }

    return new Headers({ [constants.Headers.Location]: url.href });
  }

  async function resolveHandshake() {
    const headers = new Headers({
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Credentials': 'true',
    });

    const handshakePayload = await verifyHandshakeToken(authenticateContext.handshakeToken!, authenticateContext);
    const cookiesToSet = handshakePayload.handshake;

    let sessionToken = '';
    cookiesToSet.forEach((x: string) => {
      headers.append('Set-Cookie', x);
      if (getCookieName(x).startsWith(constants.Cookies.Session)) {
        sessionToken = getCookieValue(x);
      }
    });

    if (authenticateContext.instanceType === 'development') {
      const newUrl = new URL(authenticateContext.clerkUrl);
      newUrl.searchParams.delete(constants.QueryParameters.Handshake);
      newUrl.searchParams.delete(constants.QueryParameters.HandshakeHelp);
      headers.append(constants.Headers.Location, newUrl.toString());
      headers.set(constants.Headers.CacheControl, 'no-store');
    }

    if (sessionToken === '') {
      return signedOut(authenticateContext, AuthErrorReason.SessionTokenMissing, '', headers);
    }

    const { data, errors: [error] = [] } = await verifyToken(sessionToken, authenticateContext);
    if (data) {
      return signedIn(authenticateContext, data, headers, sessionToken);
    }

    if (
      authenticateContext.instanceType === 'development' &&
      (error?.reason === TokenVerificationErrorReason.TokenExpired ||
        error?.reason === TokenVerificationErrorReason.TokenNotActiveYet)
    ) {
      error.tokenCarrier = 'cookie';
      // This probably means we're dealing with clock skew
      console.error(
        `Clerk: Clock skew detected. This usually means that your system clock is inaccurate. Clerk will attempt to account for the clock skew in development.

To resolve this issue, make sure your system's clock is set to the correct time (e.g. turn off and on automatic time synchronization).

---

${error.getFullMessage()}`,
      );

      // Retry with a generous clock skew allowance (1 day)
      const { data: retryResult, errors: [retryError] = [] } = await verifyToken(sessionToken, {
        ...authenticateContext,
        clockSkewInMs: 86_400_000,
      });
      if (retryResult) {
        return signedIn(authenticateContext, retryResult, headers, sessionToken);
      }

      throw retryError;
    }

    throw error;
  }

  async function refreshToken(authenticateContext: AuthenticateContext): Promise<string> {
    // To perform a token refresh, apiClient must be defined.
    assertApiClient(options.apiClient);
    const { sessionToken: expiredSessionToken, refreshTokenInCookie: refreshToken } = authenticateContext;
    if (!expiredSessionToken || !refreshToken) {
      throw new Error('Clerk: refreshTokenInCookie and sessionToken must be provided.');
    }
    // The token refresh endpoint requires a sessionId, so we decode that from the expired token.
    const { data: decodeResult, errors: decodedErrors } = decodeJwt(expiredSessionToken);
    if (!decodeResult || decodedErrors) {
      throw new Error(`Clerk: unable to decode session token.`);
    }
    // Perform the actual token refresh.
    const tokenResponse = await options.apiClient.sessions.refreshSession(decodeResult.payload.sid, {
      expired_token: expiredSessionToken || '',
      refresh_token: refreshToken || '',
      request_origin: authenticateContext.clerkUrl.origin,
      // The refresh endpoint expects headers as Record<string, string[]>, so we need to transform it.
      request_headers: Object.fromEntries(Array.from(request.headers.entries()).map(([k, v]) => [k, [v]])),
    });

    return tokenResponse.jwt;
  }

  async function attemptRefresh(
    authenticateContext: AuthenticateContext,
  ): Promise<{ data: { jwtPayload: JwtPayload; sessionToken: string }; error: null } | { data: null; error: any }> {
    let sessionToken: string;
    try {
      sessionToken = await refreshToken(authenticateContext);
    } catch (err: any) {
      if (err?.errors?.length) {
        return {
          data: null,
          error: {
            message: `Clerk: unable to refresh session token.`,
            cause: { reason: err.errors[0].code, errors: err.errors },
          },
        };
      } else {
        return {
          data: null,
          error: err,
        };
      }
    }
    // Since we're going to return a signedIn response, we need to decode the data from the new sessionToken.
    const { data: jwtPayload, errors } = await verifyToken(sessionToken, authenticateContext);
    if (errors) {
      return {
        data: null,
        error: {
          message: `Clerk: unable to verify refreshed session token.`,
          cause: { reason: 'invalid-session-token', errors },
        },
      };
    }
    return { data: { jwtPayload, sessionToken }, error: null };
  }

  function handleMaybeHandshakeStatus(
    authenticateContext: AuthenticateContext,
    reason: AuthErrorReason,
    message: string,
    headers?: Headers,
    refreshError?: string,
  ): SignedInState | SignedOutState | HandshakeState {
    if (isRequestEligibleForHandshake(authenticateContext)) {
      // If a refresh error is not passed in, we default to 'no-cookie' or 'non-eligible'.
      refreshError = refreshError || (authenticateContext.refreshTokenInCookie ? 'non-eligible' : 'no-cookie');

      // Right now the only usage of passing in different headers is for multi-domain sync, which redirects somewhere else.
      // In the future if we want to decorate the handshake redirect with additional headers per call we need to tweak this logic.
      const handshakeHeaders =
        headers ??
        buildRedirectToHandshake({
          requestURL: authenticateContext.clerkUrl,
          handshakeReason: reason,
          refreshError,
        });

      // Chrome aggressively caches inactive tabs. If we don't set the header here,
      // all 307 redirects will be cached and the handshake will end up in an infinite loop.
      if (handshakeHeaders.get(constants.Headers.Location)) {
        handshakeHeaders.set(constants.Headers.CacheControl, 'no-store');
      }

      // Introduce the mechanism to protect for infinite handshake redirect loops
      // using a cookie and returning true if it's infinite redirect loop or false if we can
      // proceed with triggering handshake.
      const isRedirectLoop = setHandshakeInfiniteRedirectionLoopHeaders(handshakeHeaders);
      if (isRedirectLoop) {
        const msg = `Clerk: Refreshing the session token resulted in an infinite redirect loop. This usually means that your Clerk instance keys do not match - make sure to copy the correct publishable and secret keys from the Clerk dashboard.`;
        console.log(msg);
        return signedOut(authenticateContext, reason, message);
      }

      return handshake(authenticateContext, reason, message, handshakeHeaders);
    }

    return signedOut(authenticateContext, reason, message);
  }

  /**
   * Determines if a handshake must occur to resolve a mismatch between the organization as specified
   * by the URL (according to the options) and the actual active organization on the session.
   *
   * @returns {HandshakeState | SignedOutState | null} - The function can return the following:
   *   - {HandshakeState}: If a handshake is needed to resolve the mismatched organization.
   *   - {SignedOutState}: If a handshake is required but cannot be performed.
   *   - {null}:           If no action is required.
   */
  function handleMaybeOrganizationSyncHandshake(
    authenticateContext: AuthenticateContext,
    auth: SignedInAuthObject,
  ): HandshakeState | SignedOutState | null {
    const toActivate = getOrganizationSyncTarget(authenticateContext.clerkUrl, options.organizationSyncOptions);
    if (!toActivate) {
      return null;
    }
    let mustActivate = false;
    if (toActivate.type === 'organization') {
      // Activate an org by slug?
      if (toActivate.organizationSlug && toActivate.organizationSlug !== auth.orgSlug) {
        mustActivate = true;
      }
      // Activate an org by ID?
      if (toActivate.organizationId && toActivate.organizationId !== auth.orgId) {
        mustActivate = true;
      }
    }
    // Activate the personal workspace?
    if (toActivate.type === 'personalWorkspace' && auth.orgId) {
      mustActivate = true;
    }
    if (!mustActivate) {
      return null;
    }
    if (authenticateContext.handshakeRedirectLoopCounter > 0) {
      // We have an organization that needs to be activated, but this isn't our first time redirecting.
      // This is because we attempted to activate the organization previously, but the organization
      // must not have been valid (either not found, or not valid for this user), and gave us back
      // a null organization. We won't re-try the handshake, and leave it to the server component to handle.
      console.warn(
        'Clerk: Organization activation handshake loop detected. This is likely due to an invalid organization ID or slug. Skipping organization activation.',
      );
      return null;
    }
    const handshakeState = handleMaybeHandshakeStatus(
      authenticateContext,
      AuthErrorReason.ActiveOrganizationMismatch,
      '',
    );
    if (handshakeState.status !== 'handshake') {
      // Currently, this is only possible if we're in a redirect loop, but the above check should guard against that.
      return null;
    }
    return handshakeState;
  }

  async function authenticateRequestWithTokenInHeader() {
    const { sessionTokenInHeader } = authenticateContext;

    try {
      const { data, errors } = await verifyToken(sessionTokenInHeader!, authenticateContext);
      if (errors) {
        throw errors[0];
      }
      // use `await` to force this try/catch handle the signedIn invocation
      const signedInRequestState = await signedIn(authenticateContext, data, undefined, sessionTokenInHeader!);
      // Org sync if necessary
      const handshakeRequestState = handleMaybeOrganizationSyncHandshake(
        authenticateContext,
        signedInRequestState.toAuth(),
      );
      return handshakeRequestState || signedInRequestState;
    } catch (err) {
      return handleError(err, 'header');
    }
  }

  // We want to prevent infinite handshake redirection loops.
  // We incrementally set a `__clerk_redirection_loop` cookie, and when it loops 3 times, we throw an error.
  // We also utilize the `referer` header to skip the prefetch requests.
  function setHandshakeInfiniteRedirectionLoopHeaders(headers: Headers): boolean {
    if (authenticateContext.handshakeRedirectLoopCounter === 3) {
      return true;
    }

    const newCounterValue = authenticateContext.handshakeRedirectLoopCounter + 1;
    const cookieName = constants.Cookies.RedirectCount;
    headers.append('Set-Cookie', `${cookieName}=${newCounterValue}; SameSite=Lax; HttpOnly; Max-Age=3`);
    return false;
  }

  function handleHandshakeTokenVerificationErrorInDevelopment(error: TokenVerificationError) {
    // In development, the handshake token is being transferred in the URL as a query parameter, so there is no
    // possibility of collision with a handshake token of another app running on the same local domain
    // (etc one app on localhost:3000 and one on localhost:3001).
    // Therefore, if the handshake token is invalid, it is likely that the user has switched Clerk keys locally.
    // We make sure to throw a descriptive error message and then stop the handshake flow in every case,
    // to avoid the possibility of an infinite loop.
    if (error.reason === TokenVerificationErrorReason.TokenInvalidSignature) {
      const msg = `Clerk: Handshake token verification failed due to an invalid signature. If you have switched Clerk keys locally, clear your cookies and try again.`;
      throw new Error(msg);
    }
    throw new Error(`Clerk: Handshake token verification failed: ${error.getFullMessage()}.`);
  }

  async function authenticateRequestWithTokenInCookie() {
    const hasActiveClient = authenticateContext.clientUat;
    const hasSessionToken = !!authenticateContext.sessionTokenInCookie;
    const hasDevBrowserToken = !!authenticateContext.devBrowserToken;

    const isRequestEligibleForMultiDomainSync =
      authenticateContext.isSatellite &&
      authenticateContext.secFetchDest === 'document' &&
      !authenticateContext.clerkUrl.searchParams.has(constants.QueryParameters.ClerkSynced);

    /**
     * If we have a handshakeToken, resolve the handshake and attempt to return a definitive signed in or signed out state.
     */
    if (authenticateContext.handshakeToken) {
      try {
        return await resolveHandshake();
      } catch (error) {
        // In production, the handshake token is being transferred as a cookie, so there is a possibility of collision
        // with a handshake token of another app running on the same etld+1 domain.
        // For example, if one app is running on sub1.clerk.com and another on sub2.clerk.com, the handshake token
        // cookie for both apps will be set on etld+1 (clerk.com) so there's a possibility that one app will accidentally
        // use the handshake token of a different app during the handshake flow.
        // In this scenario, verification will fail with TokenInvalidSignature. In contrast to the development case,
        // we need to allow the flow to continue so the app eventually retries another handshake with the correct token.
        // We need to make sure, however, that we don't allow the flow to continue indefinitely, so we throw an error after X
        // retries to avoid an infinite loop. An infinite loop can happen if the customer switched Clerk keys for their prod app.

        // Check the handleHandshakeTokenVerificationErrorInDevelopment function for the development case.
        if (error instanceof TokenVerificationError && authenticateContext.instanceType === 'development') {
          handleHandshakeTokenVerificationErrorInDevelopment(error);
        } else {
          console.error('Clerk: unable to resolve handshake:', error);
        }
      }
    }
    /**
     * Otherwise, check for "known unknown" auth states that we can resolve with a handshake.
     */
    if (
      authenticateContext.instanceType === 'development' &&
      authenticateContext.clerkUrl.searchParams.has(constants.QueryParameters.DevBrowser)
    ) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.DevBrowserSync, '');
    }

    /**
     * Begin multi-domain sync flows
     */
    if (authenticateContext.instanceType === 'production' && isRequestEligibleForMultiDomainSync) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.SatelliteCookieNeedsSyncing, '');
    }

    // Multi-domain development sync flow
    if (authenticateContext.instanceType === 'development' && isRequestEligibleForMultiDomainSync) {
      // initiate MD sync

      // signInUrl exists, checked at the top of `authenticateRequest`
      const redirectURL = new URL(authenticateContext.signInUrl!);
      redirectURL.searchParams.append(
        constants.QueryParameters.ClerkRedirectUrl,
        authenticateContext.clerkUrl.toString(),
      );
      const authErrReason = AuthErrorReason.SatelliteCookieNeedsSyncing;
      redirectURL.searchParams.append(constants.QueryParameters.HandshakeReason, authErrReason);
      const refreshTokenError = authenticateContext.refreshTokenInCookie ? 'non-eligible' : 'no-cookie';
      redirectURL.searchParams.append(constants.QueryParameters.RefreshTokenError, refreshTokenError);

      const headers = new Headers({ [constants.Headers.Location]: redirectURL.toString() });
      return handleMaybeHandshakeStatus(authenticateContext, authErrReason, '', headers);
    }

    // Multi-domain development sync flow
    const redirectUrl = new URL(authenticateContext.clerkUrl).searchParams.get(
      constants.QueryParameters.ClerkRedirectUrl,
    );
    if (authenticateContext.instanceType === 'development' && !authenticateContext.isSatellite && redirectUrl) {
      // Dev MD sync from primary, redirect back to satellite w/ dev browser query param
      const redirectBackToSatelliteUrl = new URL(redirectUrl);

      if (authenticateContext.devBrowserToken) {
        redirectBackToSatelliteUrl.searchParams.append(
          constants.QueryParameters.DevBrowser,
          authenticateContext.devBrowserToken,
        );
      }
      redirectBackToSatelliteUrl.searchParams.append(constants.QueryParameters.ClerkSynced, 'true');
      const authErrReason = AuthErrorReason.PrimaryRespondsToSyncing;
      redirectBackToSatelliteUrl.searchParams.append(constants.QueryParameters.HandshakeReason, authErrReason);
      const refreshTokenError = authenticateContext.refreshTokenInCookie ? 'non-eligible' : 'no-cookie';
      redirectBackToSatelliteUrl.searchParams.append(constants.QueryParameters.RefreshTokenError, refreshTokenError);

      const headers = new Headers({ [constants.Headers.Location]: redirectBackToSatelliteUrl.toString() });
      return handleMaybeHandshakeStatus(authenticateContext, authErrReason, '', headers);
    }
    /**
     * End multi-domain sync flows
     */

    if (authenticateContext.instanceType === 'development' && !hasDevBrowserToken) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.DevBrowserMissing, '');
    }

    if (!hasActiveClient && !hasSessionToken) {
      return signedOut(authenticateContext, AuthErrorReason.SessionTokenAndUATMissing, '');
    }

    // This can eagerly run handshake since client_uat is SameSite=Strict in dev
    if (!hasActiveClient && hasSessionToken) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.SessionTokenWithoutClientUAT, '');
    }

    if (hasActiveClient && !hasSessionToken) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.ClientUATWithoutSessionToken, '');
    }

    const { data: decodeResult, errors: decodedErrors } = decodeJwt(authenticateContext.sessionTokenInCookie!);

    if (decodedErrors) {
      return handleError(decodedErrors[0], 'cookie');
    }

    if (decodeResult.payload.iat < authenticateContext.clientUat) {
      return handleMaybeHandshakeStatus(authenticateContext, AuthErrorReason.SessionTokenOutdated, '');
    }

    try {
      const { data, errors } = await verifyToken(authenticateContext.sessionTokenInCookie!, authenticateContext);
      if (errors) {
        throw errors[0];
      }
      // use `await` to force this try/catch handle the signedIn invocation
      const signedInRequestState = await signedIn(
        authenticateContext,
        data,
        undefined,
        authenticateContext.sessionTokenInCookie!,
      );

      // Org sync if necessary
      const handshakeRequestState = handleMaybeOrganizationSyncHandshake(
        authenticateContext,
        signedInRequestState.toAuth(),
      );
      if (handshakeRequestState) {
        return handshakeRequestState;
      }

      return signedInRequestState;
    } catch (err) {
      return handleError(err, 'cookie');
    }

    return signedOut(authenticateContext, AuthErrorReason.UnexpectedError);
  }

  async function handleError(
    err: unknown,
    tokenCarrier: TokenCarrier,
  ): Promise<SignedInState | SignedOutState | HandshakeState> {
    if (!(err instanceof TokenVerificationError)) {
      return signedOut(authenticateContext, AuthErrorReason.UnexpectedError);
    }

    let refreshError: string = authenticateContext.refreshTokenInCookie ? 'non-eligible' : 'no-cookie';

    if (isRequestEligibleForRefresh(err, authenticateContext, request)) {
      const { data, error } = await attemptRefresh(authenticateContext);
      if (!error) {
        return signedIn(authenticateContext, data!.jwtPayload, undefined, data!.sessionToken);
      }

      // If there's any error, simply fallback to the handshake flow.
      console.error('Clerk: unable to refresh token:', error?.message || error);
      if (error?.cause?.reason) {
        refreshError = error.cause.reason;
      } else {
        refreshError = 'unexpected-refresh-error';
      }
    }

    err.tokenCarrier = tokenCarrier;

    const reasonToHandshake = [
      TokenVerificationErrorReason.TokenExpired,
      TokenVerificationErrorReason.TokenNotActiveYet,
    ].includes(err.reason);

    if (reasonToHandshake) {
      return handleMaybeHandshakeStatus(
        authenticateContext,
        AuthErrorReason.SessionTokenOutdated,
        err.getFullMessage(),
        undefined,
        refreshError,
      );
    }

    return signedOut(authenticateContext, err.reason, err.getFullMessage());
  }

  if (authenticateContext.sessionTokenInHeader) {
    return authenticateRequestWithTokenInHeader();
  }

  return authenticateRequestWithTokenInCookie();
}

/**
 * @internal
 */
export const debugRequestState = (params: RequestState) => {
  const { isSignedIn, proxyUrl, reason, message, publishableKey, isSatellite, domain } = params;
  return { isSignedIn, proxyUrl, reason, message, publishableKey, isSatellite, domain };
};

/**
 * Determines if the given URL and settings indicate a desire to activate a specific
 * organization or personal workspace.
 *
 * @returns {OrganizationSyncTarget | null} - The function can return the following:
 *  - {OrganizationSyncTarget}: If the URL and settings indicate a desire to activate an organization or personal workspace.
 */
export function getOrganizationSyncTarget(
  url: URL,
  options: OrganizationSyncOptions | undefined,
): OrganizationSyncTarget | null {
  if (!options) {
    return null;
  }

  // Check for personal workspace activation
  if (options.personalWorkspacePatterns) {
    let matcher: MatchFunction<Partial<Record<string, string | string[]>>>;
    try {
      matcher = match(options.personalWorkspacePatterns);
    } catch (e) {
      console.error(`Invalid personal workspace pattern "${options.personalWorkspacePatterns}": "${e}"`);
      return null;
    }

    let personalResult: Match<Partial<Record<string, string | string[]>>>;
    try {
      personalResult = matcher(url.pathname);
    } catch (e) {
      // Intentionally not logging the path to avoid potentially leaking anything sensitive
      console.error(`Failed to apply personal workspace pattern "${options.personalWorkspacePatterns}" to a path`, e);
      return null;
    }

    if (personalResult) {
      return { type: 'personalWorkspace' };
    }
  }

  // Check for organization activation
  if (options.organizationPatterns) {
    let matcher: MatchFunction<Partial<Record<string, string | string[]>>>;
    try {
      matcher = match(options.organizationPatterns);
    } catch (e) {
      console.error(`Clerk: Invalid organization pattern "${options.organizationPatterns}": "${e}"`);
      return null;
    }

    let orgResult: Match<Partial<Record<string, string | string[]>>>;
    try {
      orgResult = matcher(url.pathname);
    } catch (e) {
      // Intentionally not logging the path to avoid potentially leaking anything sensitive
      console.error(`Clerk: Failed to apply organization pattern "${options.organizationPatterns}" to a path`, e);
      return null;
    }

    if (orgResult) {
      const { slug = '', id = '' } = orgResult.params as { slug?: string; id?: string };
      if (id) {
        return { type: 'organization', organizationId: id };
      }
      if (slug) {
        return { type: 'organization', organizationSlug: slug };
      }
      console.warn(
        'Clerk: Detected an organization pattern match, but no organization ID or slug was found in the URL. Does the pattern include `:id` or `:slug`?',
      );
    }
  }
  return null;
}

/**
 * Represents an organization or a personal workspace - e.g. an
 * entity that can be activated by the handshake API.
 */
export type OrganizationSyncTarget =
  | { type: 'personalWorkspace' }
  | { type: 'organization'; organizationId?: string; organizationSlug?: string };

/**
 * Generates the query parameters to activate an organization or personal workspace
 * via the FAPI handshake api.
 */
function getOrganizationSyncQueryParams(toActivate: OrganizationSyncTarget): Map<string, string> {
  const ret = new Map();
  if (toActivate.type === 'personalWorkspace') {
    ret.set('organization_id', '');
  }
  if (toActivate.type === 'organization') {
    if (toActivate.organizationId) {
      ret.set('organization_id', toActivate.organizationId);
    }
    if (toActivate.organizationSlug) {
      ret.set('organization_id', toActivate.organizationSlug);
    }
  }
  return ret;
}
