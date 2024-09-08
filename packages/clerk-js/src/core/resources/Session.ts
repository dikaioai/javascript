import { runWithExponentialBackOff } from '@clerk/shared';
import { is4xxError } from '@clerk/shared/error';
import type {
  __experimental_SessionVerificationJSON,
  __experimental_SessionVerificationMaxAge,
  __experimental_SessionVerificationResource,
  __experimental_SessionVerifyAttemptFirstFactorParams,
  __experimental_SessionVerifyAttemptSecondFactorParams,
  __experimental_SessionVerifyCreateParams,
  __experimental_SessionVerifyPrepareFirstFactorParams,
  __experimental_SessionVerifyPrepareSecondFactorParams,
  ActJWTClaim,
  CheckAuthorization,
  EmailCodeConfig,
  GetToken,
  GetTokenOptions,
  PhoneCodeConfig,
  SessionJSON,
  SessionResource,
  SessionStatus,
  TokenResource,
  UserResource,
} from '@clerk/types';

import { unixEpochToDate } from '../../utils/date';
import { clerkInvalidStrategy } from '../errors';
import { eventBus, events } from '../events';
import { SessionTokenCache } from '../tokenCache';
import { BaseResource, PublicUserData, Token, User } from './internal';
import { SessionVerification } from './SessionVerification';

const stringsToNumbers: { [key in '1m' | __experimental_SessionVerificationMaxAge]: number } = {
  '1m': 1,
  'A1.10min': 10,
  'A2.1hr': 60,
  'A3.4hr': 240, //4 * 60,
  'A4.1day': 1440, //24 * 60,
  'A5.1wk': 10080, //7 * 24 * 60,
};

export class Session extends BaseResource implements SessionResource {
  pathRoot = '/client/sessions';

  id!: string;
  status!: SessionStatus;
  lastActiveAt!: Date;
  lastActiveToken!: TokenResource | null;
  lastActiveOrganizationId!: string | null;
  actor!: ActJWTClaim | null;
  user!: UserResource | null;
  publicUserData!: PublicUserData;
  __experimental_factorVerificationAge: [number | null, number | null] = [null, null];
  expireAt!: Date;
  abandonAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;

  static isSessionResource(resource: unknown): resource is Session {
    return !!resource && resource instanceof Session;
  }

  constructor(data: SessionJSON) {
    super();

    this.fromJSON(data);
    this.#hydrateCache(this.lastActiveToken);
  }

  end = (): Promise<SessionResource> => {
    SessionTokenCache.clear();
    return this._basePost({
      action: 'end',
    });
  };

  remove = (): Promise<SessionResource> => {
    SessionTokenCache.clear();
    return this._basePost({
      action: 'remove',
    });
  };

  touch = (): Promise<SessionResource> => {
    return this._basePost({
      action: 'touch',
      body: { active_organization_id: this.lastActiveOrganizationId },
    });
  };

  clearCache = (): void => {
    return SessionTokenCache.clear();
  };

  getToken: GetToken = async (options?: GetTokenOptions): Promise<string | null> => {
    return runWithExponentialBackOff(() => this._getToken(options), {
      shouldRetry: (error: unknown, currentIteration: number) => !is4xxError(error) && currentIteration < 4,
    });
  };

  checkAuthorization: CheckAuthorization = params => {
    let orgAuthorization = null;
    let stepUpAuthorization = null;
    if (!this.user) {
      return false;
    }

    if (params.role || params.permission) {
      const orgMemberships = this.user.organizationMemberships || [];
      const activeMembership = orgMemberships.find(mem => mem.organization.id === this.lastActiveOrganizationId);

      const activeOrganizationPermissions = activeMembership?.permissions;
      const activeOrganizationRole = activeMembership?.role;

      const missingOrgs = !activeMembership;

      if (params.permission && !missingOrgs) {
        orgAuthorization = activeOrganizationPermissions!.includes(params.permission);
      }

      if (params.role && !missingOrgs) {
        orgAuthorization = activeOrganizationRole === params.role;
      }
    }

    if (params.__experimental_assurance && this.__experimental_factorVerificationAge) {
      const hasValidFactorOne =
        this.__experimental_factorVerificationAge[0] !== null
          ? stringsToNumbers[params.__experimental_assurance.maxAge] > this.__experimental_factorVerificationAge[0]
          : false;
      const hasValidFactorTwo =
        this.__experimental_factorVerificationAge[1] !== null
          ? stringsToNumbers[params.__experimental_assurance.maxAge] > this.__experimental_factorVerificationAge[1]
          : false;

      if (params.__experimental_assurance.level === 'L1.firstFactor') {
        stepUpAuthorization = hasValidFactorOne;
      } else if (params.__experimental_assurance.level === 'L2.secondFactor') {
        stepUpAuthorization = hasValidFactorTwo;
      } else {
        stepUpAuthorization = hasValidFactorOne && hasValidFactorTwo;
      }
    }

    return [orgAuthorization, stepUpAuthorization].filter(Boolean).some(a => a === true);
  };

  #hydrateCache = (token: TokenResource | null) => {
    if (token) {
      SessionTokenCache.set({
        tokenId: this.#getCacheId(),
        tokenResolver: Promise.resolve(token),
      });
      eventBus.dispatch(events.TokenUpdate, { token });
    }
  };

  // If it's a session token, retrieve it with their session id, otherwise it's a jwt template token
  // and retrieve it using the session id concatenated with the jwt template name.
  // e.g. session id is 'sess_abc12345' and jwt template name is 'haris'
  // The session token ID will be 'sess_abc12345' and the jwt template token ID will be 'sess_abc12345-haris'
  #getCacheId(template?: string, organizationId?: string | null) {
    const resolvedOrganizationId =
      typeof organizationId === 'undefined' ? this.lastActiveOrganizationId : organizationId;
    return [this.id, template, resolvedOrganizationId, this.updatedAt.getTime()].filter(Boolean).join('-');
  }

  __experimental_startVerification = async ({
    level,
    maxAge,
  }: __experimental_SessionVerifyCreateParams): Promise<__experimental_SessionVerificationResource> => {
    const searchParams = new URLSearchParams();
    searchParams.append('_clerk_session_id', this.id);
    const json = (
      await BaseResource._fetch({
        method: 'POST',
        path: `/client/sessions/${this.id}/verify`,
        body: {
          level,
          maxAge,
        } as any,
        search: searchParams,
      })
    )?.response as unknown as __experimental_SessionVerificationJSON;

    return new SessionVerification(json);
  };

  __experimental_prepareFirstFactorVerification = async (
    factor: __experimental_SessionVerifyPrepareFirstFactorParams,
  ): Promise<__experimental_SessionVerificationResource> => {
    const searchParams = new URLSearchParams();
    searchParams.append('_clerk_session_id', this.id);
    let config;
    switch (factor.strategy) {
      case 'email_code':
        config = { emailAddressId: factor.emailAddressId } as EmailCodeConfig;
        break;
      case 'phone_code':
        config = {
          phoneNumberId: factor.phoneNumberId,
          default: factor.default,
        } as PhoneCodeConfig;
        break;
      default:
        clerkInvalidStrategy('Session.prepareFirstFactorVerification', (factor as any).strategy);
    }

    const json = (
      await BaseResource._fetch({
        method: 'POST',
        path: `/client/sessions/${this.id}/verify/prepare_first_factor`,
        body: {
          ...config,
          strategy: factor.strategy,
        } as any,
        search: searchParams,
      })
    )?.response as unknown as __experimental_SessionVerificationJSON;

    return new SessionVerification(json);
  };

  __experimental_attemptFirstFactorVerification = async (
    attemptFactor: __experimental_SessionVerifyAttemptFirstFactorParams,
  ): Promise<__experimental_SessionVerificationResource> => {
    const searchParams = new URLSearchParams();
    searchParams.append('_clerk_session_id', this.id);
    const json = (
      await BaseResource._fetch({
        method: 'POST',
        path: `/client/sessions/${this.id}/verify/attempt_first_factor`,
        body: { ...attemptFactor, strategy: attemptFactor.strategy } as any,
        search: searchParams,
      })
    )?.response as unknown as __experimental_SessionVerificationJSON;

    return new SessionVerification(json);
  };

  __experimental_prepareSecondFactorVerification = async (
    params: __experimental_SessionVerifyPrepareSecondFactorParams,
  ): Promise<__experimental_SessionVerificationResource> => {
    const searchParams = new URLSearchParams();
    searchParams.append('_clerk_session_id', this.id);
    const json = (
      await BaseResource._fetch({
        method: 'POST',
        path: `/client/sessions/${this.id}/verify/prepare_second_factor`,
        body: params as any,
        search: searchParams,
      })
    )?.response as unknown as __experimental_SessionVerificationJSON;

    return new SessionVerification(json);
  };

  __experimental_attemptSecondFactorVerification = async (
    params: __experimental_SessionVerifyAttemptSecondFactorParams,
  ): Promise<__experimental_SessionVerificationResource> => {
    const searchParams = new URLSearchParams();
    searchParams.append('_clerk_session_id', this.id);
    const json = (
      await BaseResource._fetch({
        method: 'POST',
        path: `/client/sessions/${this.id}/verify/attempt_second_factor`,
        body: params as any,
        search: searchParams,
      })
    )?.response as unknown as __experimental_SessionVerificationJSON;

    return new SessionVerification(json);
  };

  protected fromJSON(data: SessionJSON | null): this {
    if (!data) {
      return this;
    }

    this.id = data.id;
    this.status = data.status;
    this.expireAt = unixEpochToDate(data.expire_at);
    this.abandonAt = unixEpochToDate(data.abandon_at);
    this.__experimental_factorVerificationAge = data.factor_verification_age;
    this.lastActiveAt = unixEpochToDate(data.last_active_at);
    this.lastActiveOrganizationId = data.last_active_organization_id;
    this.actor = data.actor;
    this.createdAt = unixEpochToDate(data.created_at);
    this.updatedAt = unixEpochToDate(data.updated_at);
    this.user = new User(data.user);

    if (data.public_user_data) {
      this.publicUserData = new PublicUserData(data.public_user_data);
    }

    this.lastActiveToken = data.last_active_token ? new Token(data.last_active_token) : null;

    return this;
  }

  private async _getToken(options?: GetTokenOptions): Promise<string | null> {
    if (!this.user) {
      return null;
    }

    const { leewayInSeconds, template, skipCache = false } = options || {};

    // If no organization ID is provided, default to the selected organization in memory
    // Note: this explicitly allows passing `null` or `""`, which should select the personal workspace.
    const organizationId =
      typeof options?.organizationId === 'undefined' ? this.lastActiveOrganizationId : options?.organizationId;

    if (!template && Number(leewayInSeconds) >= 60) {
      throw new Error('Leeway can not exceed the token lifespan (60 seconds)');
    }

    const tokenId = this.#getCacheId(template, organizationId);
    const cachedEntry = skipCache ? undefined : SessionTokenCache.get({ tokenId }, leewayInSeconds);

    // Dispatch tokenUpdate only for __session tokens with the session's active organization ID, and not JWT templates
    const shouldDispatchTokenUpdate = !template && organizationId === this.lastActiveOrganizationId;

    if (cachedEntry) {
      const cachedToken = await cachedEntry.tokenResolver;
      if (shouldDispatchTokenUpdate) {
        eventBus.dispatch(events.TokenUpdate, { token: cachedToken });
      }
      // Return null when raw string is empty to indicate that there it's signed-out
      return cachedToken.getRawString() || null;
    }
    const path = template ? `${this.path()}/tokens/${template}` : `${this.path()}/tokens`;
    // TODO: update template endpoint to accept organizationId
    const params = template ? {} : { organizationId };
    const tokenResolver = Token.create(path, params);
    SessionTokenCache.set({ tokenId, tokenResolver });
    return tokenResolver.then(token => {
      if (shouldDispatchTokenUpdate) {
        eventBus.dispatch(events.TokenUpdate, { token });
      }
      // Return null when raw string is empty to indicate that there it's signed-out
      return token.getRawString() || null;
    });
  }
}
