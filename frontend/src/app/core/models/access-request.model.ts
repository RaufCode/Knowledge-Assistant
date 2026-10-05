import type { Role } from './auth.model';

/** `POST /api/auth/request-access` request body. */
export interface AccessRequestDto {
  name: string;
  email: string;
  password: string;
}

/**
 * The answer to a request for access.
 *
 * Carries nothing but a status. The endpoint is unauthenticated, so anything more
 * informative would be a way to ask it which addresses already have accounts.
 */
export interface AccessRequestSubmittedDto {
  status: 'received';
}

/** Where a request has got to. */
export type AccessRequestStatus = 'pending' | 'approved' | 'declined';

/** One request, as an administrator sees it. */
export interface AccessRequestRowDto {
  id: string;
  name: string;
  email: string;
  status: AccessRequestStatus;
  /** ISO timestamp. The backend sends no designator, so it is read as UTC. */
  requested_at: string;
  decided_at: string | null;
}

/** `GET /api/auth/requests` response. */
export interface AccessRequestListDto {
  requests: AccessRequestRowDto[];
}

/** `POST /api/auth/requests/{id}/approve` request body. */
export interface AccessRequestDecisionRequestDto {
  role: Role;
}

/**
 * The outcome of a decision.
 *
 * `invite_link` is empty for a decline, and for an approval where the account had
 * already been provisioned another way. Empty rather than null because the field is
 * always there and only sometimes has anything in it.
 */
export interface AccessRequestDecisionDto {
  request: AccessRequestRowDto;
  invite_link: string;
  token: string;
  expires_at: string;
}

/** `POST /api/auth/accounts` request body. */
export interface CreateAccountRequestDto {
  name: string;
  email: string;
  role: Role;
  password: string;
}
