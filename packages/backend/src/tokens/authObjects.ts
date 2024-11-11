import { createCheckAuthorization } from '@clerk/shared/authorization';
import type {
  ActClaim,
  CheckAuthorizationWithCustomPermissions,
  JwtPayload,
  OrganizationCustomPermissionKey,
  OrganizationCustomRoleKey,
  ServerGetToken,
  ServerGetTokenOptions,
} from '@clerk/types';

import type { CreateBackendApiOptions } from '../api';
import { createBackendApiClient } from '../api';
import type { AuthenticateContext } from './authenticateContext';

type AuthObjectDebugData = Record<string, any>;
type AuthObjectDebug = () => AuthObjectDebugData;

/**
 * @internal
 */
export type SignedInAuthObjectOptions = CreateBackendApiOptions & {
  token: string;
};

/**
 * @internal
 */
export type SignedInAuthObject = {
  sessionClaims: JwtPayload;
  sessionId: string;
  actor: ActClaim | undefined;
  userId: string | null;
  machineId: string | null;
  orgId: string | undefined;
  orgRole: OrganizationCustomRoleKey | undefined;
  orgSlug: string | undefined;
  orgPermissions: OrganizationCustomPermissionKey[] | undefined;
  /**
   * Factor Verification Age
   * Each item represents the minutes that have passed since the last time a first or second factor were verified.
   * [fistFactorAge, secondFactorAge]
   * @experimental This API is experimental and may change at any moment.
   */
  __experimental_factorVerificationAge: [number, number] | null;
  getToken: ServerGetToken;
  has: CheckAuthorizationWithCustomPermissions;
  debug: AuthObjectDebug;
};

/**
 * @internal
 */
export type SignedOutAuthObject = {
  sessionClaims: null;
  sessionId: null;
  actor: null;
  userId: null;
  machineId: null;
  orgId: null;
  orgRole: null;
  orgSlug: null;
  orgPermissions: null;
  /**
   * Factor Verification Age
   * Each item represents the minutes that have passed since the last time a first or second factor were verified.
   * [fistFactorAge, secondFactorAge]
   * @experimental This API is experimental and may change at any moment.
   */
  __experimental_factorVerificationAge: null;
  getToken: ServerGetToken;
  has: CheckAuthorizationWithCustomPermissions;
  debug: AuthObjectDebug;
};

/**
 * @internal
 */
export type AuthObject = SignedInAuthObject | SignedOutAuthObject;

const createDebug = (data: AuthObjectDebugData | undefined) => {
  return () => {
    const res = { ...data };
    res.secretKey = (res.secretKey || '').substring(0, 7);
    res.jwtKey = (res.jwtKey || '').substring(0, 7);
    return { ...res };
  };
};

/**
 * @internal
 */
export function signedInAuthObject(
  authenticateContext: AuthenticateContext,
  sessionToken: string,
  sessionClaims: JwtPayload,
): SignedInAuthObject {
  const {
    act: actor,
    sid: sessionId,
    org_id: orgId,
    org_role: orgRole,
    org_slug: orgSlug,
    org_permissions: orgPermissions,
    sub,
    fva,
  } = sessionClaims;
  const apiClient = createBackendApiClient(authenticateContext);
  const getToken = createGetToken({
    sessionId,
    sessionToken,
    fetcher: async (...args) => (await apiClient.sessions.getToken(...args)).jwt,
  });

  // fva can be undefined for instances that have not opt-in
  const __experimental_factorVerificationAge = fva ?? null;

  let userId: string | null = null;
  let machineId: string | null = null;

  if (typeof sub === 'string') {
    if (sub.startsWith('mch_')) {
      machineId = sub;
    } else {
      userId = sub;
    }
  }

  return {
    actor,
    sessionClaims,
    sessionId,
    userId,
    machineId,
    orgId,
    orgRole,
    orgSlug,
    orgPermissions,
    __experimental_factorVerificationAge,
    getToken,
    has: createCheckAuthorization({ orgId, orgRole, orgPermissions, userId, __experimental_factorVerificationAge }),
    debug: createDebug({ ...authenticateContext, sessionToken }),
  };
}

/**
 * @internal
 */
export function signedOutAuthObject(debugData?: AuthObjectDebugData): SignedOutAuthObject {
  return {
    sessionClaims: null,
    sessionId: null,
    userId: null,
    machineId: null,
    actor: null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    orgPermissions: null,
    __experimental_factorVerificationAge: null,
    getToken: () => Promise.resolve(null),
    has: () => false,
    debug: createDebug(debugData),
  };
}

/**
 * Auth objects moving through the server -> client boundary need to be serializable
 * as we need to ensure that they can be transferred via the network as pure strings.
 * Some frameworks like Remix or Next (/pages dir only) handle this serialization by simply
 * ignoring any non-serializable keys, however Nextjs /app directory is stricter and
 * throws an error if a non-serializable value is found.
 * @internal
 */
export const makeAuthObjectSerializable = <T extends Record<string, unknown>>(obj: T): T => {
  // remove any non-serializable props from the returned object

  const { debug, getToken, has, ...rest } = obj as unknown as AuthObject;
  return rest as unknown as T;
};

type TokenFetcher = (sessionId: string, template: string) => Promise<string>;

type CreateGetToken = (params: { sessionId: string; sessionToken: string; fetcher: TokenFetcher }) => ServerGetToken;

const createGetToken: CreateGetToken = params => {
  const { fetcher, sessionToken, sessionId } = params || {};

  return async (options: ServerGetTokenOptions = {}) => {
    if (!sessionId) {
      return null;
    }

    if (options.template) {
      return fetcher(sessionId, options.template);
    }

    return sessionToken;
  };
};
