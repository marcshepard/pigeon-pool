/**
 * Data types returned from the backend API
 */

// src/backend/types.ts

// ---- Errors ----
export class DataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataValidationError";
  }
}

// ---- Narrowing helpers ----
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isString(x: unknown): x is string {
  return typeof x === "string";
}
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

// ---- SessionInfo ----
export class SessionInfo {
  expires_at: string;

  constructor(data: unknown) {
    if (!isRecord(data) || !isString(data.expires_at)) {
      throw new DataValidationError("Invalid SessionInfo data");
    }
    this.expires_at = data.expires_at;
  }
}

// ---- Me (result of /auth/me or /auth/login) ----
export class Me {
  pigeon_number: number;
  pigeon_name: string;
  email: string;
  is_admin: boolean;
  session: SessionInfo;

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid Me payload (not an object)");

    const { pigeon_number, pigeon_name, email, is_admin, session } = data;

    if (!isNumber(pigeon_number)) throw new DataValidationError("pigeon_number must be number");
    if (!isString(pigeon_name)) throw new DataValidationError("pigeon_name must be string");
    if (!isString(email)) throw new DataValidationError("email must be string");
    if (!isBoolean(is_admin)) throw new DataValidationError("is_admin must be boolean");

    this.pigeon_number = pigeon_number;
    this.pigeon_name = pigeon_name;
    this.email = email;
    this.is_admin = is_admin;
    this.session = new SessionInfo(session);
  }
}

// ---- Request payload classes (for convenience) ----
export class LoginPayload {
  email?: string;
  pigeon_number?: number;
  password: string;

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid LoginPayload (not an object)");
    if (!isString(data.password)) throw new DataValidationError("password is required");

    if (!data.email && !data.pigeon_number) {
      throw new DataValidationError("Provide either email or pigeon_number");
    }
    if (data.email !== undefined && !isString(data.email)) {
      throw new DataValidationError("email must be string");
    }
    if (data.pigeon_number !== undefined && !isNumber(data.pigeon_number)) {
      throw new DataValidationError("pigeon_number must be number");
    }

    this.email = data.email as string | undefined;
    this.pigeon_number = data.pigeon_number as number | undefined;
    this.password = data.password as string;
  }
}

export class PasswordResetRequest {
  email: string;

  constructor(data: unknown) {
    if (!isRecord(data) || !isString(data.email)) {
      throw new DataValidationError("Invalid PasswordResetRequest");
    }
    this.email = data.email;
  }
}

export class PasswordResetConfirm {
  token: string;
  new_password: string;

  constructor(data: unknown) {
    if (!isRecord(data) || !isString(data.token) || !isString(data.new_password)) {
      throw new DataValidationError("Invalid PasswordResetConfirm");
    }
    this.token = data.token;
    this.new_password = data.new_password;
  }
}

// ---- Generic API error wrapper (optional) ----
export class ApiError {
  detail: string;

  constructor(data: unknown) {
    if (!isRecord(data) || !isString(data.detail)) {
      throw new DataValidationError("Invalid ApiError data");
    }
    this.detail = data.detail;
  }
}

// ---- Ok ----
export class Ok {
  ok: true;

  constructor(data: unknown) {
    if (!isRecord(data) || data.ok !== true) {
      throw new DataValidationError("Invalid Ok response");
    }
    this.ok = true;
  }
}

