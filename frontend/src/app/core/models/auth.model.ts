/**
 * Wire types for the auth routes, transcribed from the backend's OpenAPI schema.
 *
 * Nothing here is a token, and that is the point of the file existing: the backend
 * keeps both tokens in `httpOnly` cookies that this code cannot read, so there is
 * no type in it to represent one. The only session state the app ever handles is
 * the user the backend describes.
 */

/**
 * Permission level, as the server names it.
 *
 * `admin` rather than Phase 1's `administrator`: these are the values the backend
 * stores and compares, and mapping them to a friendlier word here would mean
 * translating at every comparison. The label shown to a person stays "HR
 * Administrator" in `ROLE_LABELS`.
 */
export type Role = 'employee' | 'admin';

/** `GET /api/auth/me` response: the signed-in person. */
export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** `POST /api/auth/login` and `POST /api/auth/accept-invite` response. */
export interface UserResponseDto {
  user: UserDto;
}

/** `POST /api/auth/login` request body. */
export interface LoginRequestDto {
  email: string;
  password: string;
}

/** `POST /api/auth/accept-invite` request body. */
export interface AcceptInviteRequestDto {
  token: string;
  password: string;
}

/** `POST /api/auth/invite` request body. Administrators only. */
export interface InviteRequestDto {
  name: string;
  email: string;
  role: Role;
}

/** `POST /api/auth/invite` response, including the link to pass on. */
export interface InviteResponseDto {
  invite_link: string;
  token: string;
  expires_at: string;
  user: UserDto;
}

/** `GET /api/auth/invite/{token}` response, used to pre-fill the accept screen. */
export interface InvitePreviewDto {
  name: string;
  email: string;
  role: Role;
  expires_at: string;
}

/** `GET /api/auth/csrf` response. */
export interface CsrfResponseDto {
  csrf_token: string;
}

/**
 * How long a password must be, at minimum.
 *
 * The backend refuses anything shorter, so this is a UX copy of a rule the server
 * enforces rather than the rule itself. Kept next to the model it belongs to so
 * the two cannot drift apart without that being obvious.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The longest password the backend will store, mirrored here.
 *
 * Present because the length policy was checked at one end only. A password past
 * this was accepted by the form and then refused by the server, which is the worst
 * way to find out: the round trip reports a rejection the form said was fine.
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The longest name the backend will store, for the same reason.
 *
 * `NameStr` on the backend caps this at 120; nothing in the form did.
 */
export const MAX_NAME_LENGTH = 120;

/** The company domain an address has to be in, for the hint on the login screen. */
export const COMPANY_EMAIL_DOMAIN = 'acmetech.example';

/**
 * Whether an address looks like it belongs to the company.
 *
 * A convenience for the message under the field, and nothing more: the same check
 * runs on the server, and the server's answer is the one that counts. A form that
 * blocked a valid address would be worse than one that lets an invalid one through
 * to be refused properly.
 */
export function isCompanyEmail(value: string): boolean {
  const domain = value.trim().toLowerCase().split('@').pop() ?? '';

  return domain === COMPANY_EMAIL_DOMAIN;
}

/** Human-readable names for each role, as they are shown to a person. */
export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Employee',
  admin: 'HR Administrator',
};
