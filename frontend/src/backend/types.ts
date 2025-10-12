/**
 * Data types returned from the backend API
 */

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

// =============================
// Generic types
// =============================
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

export class DataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataValidationError";
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

// =============================
// Login types
// =============================
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

// =============================
// Game schedule types
// =============================

/** Which weeks are most interesting to the user */
export class ScheduleCurrent {
  next_picks_week: number | null; // Next unlocked week that users can still make picks for
  live_week: number | null;       // In-progress week, or null between MNF and TNF kickoff

  constructor(data: unknown) {
    if (!isRecord(data)) {
      throw new DataValidationError("Invalid ScheduleCurrent payload (not an object)");
    }
    this.next_picks_week = data.next_picks_week === null ? null : Number(data.next_picks_week);
    this.live_week = data.live_week === null ? null : Number(data.live_week);
  }
}

/** Game row as returned by GET /schedule/{week_number}/games */
export class Game {
  game_id: number;
  week_number: number;
  kickoff_at: string; // ISO string from the API (UTC)
  home_abbr: string;
  away_abbr: string;
  status: "scheduled" | "in_progress" | "final";
  home_score: number | null;
  away_score: number | null;

  constructor(data: unknown) {
    if (!isRecord(data)) {
      throw new DataValidationError("Invalid Game payload (not an object)");
    }
    const {
      game_id,
      week_number,
      kickoff_at,
      home_abbr,
      away_abbr,
      status,
      home_score,
      away_score,
    } = data;
    if (!isNumber(game_id)) throw new DataValidationError("game_id must be number");
    if (!isNumber(week_number)) throw new DataValidationError("week_number must be number");
    if (!isString(kickoff_at)) throw new DataValidationError("kickoff_at must be string");
    if (!isString(home_abbr)) throw new DataValidationError("home_abbr must be string");
    if (!isString(away_abbr)) throw new DataValidationError("away_abbr must be string");
    if (status !== "scheduled" && status !== "in_progress" && status !== "final") {
      throw new DataValidationError("status must be 'scheduled', 'in_progress', or 'final'");
    }
    if (home_score !== null && !isNumber(home_score)) {
      throw new DataValidationError("home_score must be number or null");
    }
    if (away_score !== null && !isNumber(away_score)) {
      throw new DataValidationError("away_score must be number or null");
    }
    this.game_id = game_id;
    this.week_number = week_number;
    this.kickoff_at = kickoff_at;
    this.home_abbr = home_abbr;
    this.away_abbr = away_abbr;
    this.status = status;
    this.home_score = home_score;
    this.away_score = away_score;
  }
}

// =============================
// Picks types
// =============================
// ---- Picks API types ----
export class PickIn {
  game_id: number;
  picked_home: boolean;
  predicted_margin: number;

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid PickIn payload (not an object)");
    if (!isNumber(data.game_id)) throw new DataValidationError("game_id must be number");
    if (!isBoolean(data.picked_home)) throw new DataValidationError("picked_home must be boolean");
    if (!isNumber(data.predicted_margin) || data.predicted_margin < 0) throw new DataValidationError("predicted_margin must be non-negative number");
    this.game_id = data.game_id;
    this.picked_home = data.picked_home;
    this.predicted_margin = data.predicted_margin;
  }
}

export class PickOut {
  pigeon_number: number;
  game_id: number;
  picked_home: boolean;
  predicted_margin: number;
  created_at: string | null; // ISO string from the API (UTC), or null if no pick submitted

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid PickOut payload (not an object)");
    if (!isNumber(data.pigeon_number)) throw new DataValidationError("pigeon_number must be number");
    if (!isNumber(data.game_id)) throw new DataValidationError("game_id must be number");
    if (!isBoolean(data.picked_home)) throw new DataValidationError("picked_home must be boolean");
    if (!isNumber(data.predicted_margin)) throw new DataValidationError("predicted_margin must be number");
    if (!(isString(data.created_at) || data.created_at === null)) throw new DataValidationError("created_at must be string or null");
    this.pigeon_number = data.pigeon_number;
    this.game_id = data.game_id;
    this.picked_home = data.picked_home;
    this.predicted_margin = data.predicted_margin;
    this.created_at = data.created_at;
  }
}

export class PicksBulkIn {
  week_number: number;
  picks: PickIn[];

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid PicksBulkIn payload (not an object)");
    if (!isNumber(data.week_number) || data.week_number < 1 || data.week_number > 18) throw new DataValidationError("week_number must be 1-18");
    if (!Array.isArray(data.picks)) throw new DataValidationError("picks must be array");
    // Check for duplicate game_id
    const seen = new Set<number>();
    this.picks = data.picks.map((p) => {
      const pick = new PickIn(p);
      if (seen.has(pick.game_id)) throw new DataValidationError(`Duplicate game_id ${pick.game_id} in picks`);
      seen.add(pick.game_id);
      return pick;
    });
    this.week_number = data.week_number;
  }
}

// =============================
// Results / Leaderboard types
// =============================

/** Read-only pick row for a locked week (joined with game metadata). */
export class WeekPicksRow {
  pigeon_number: number;
  pigeon_name: string;
  game_id: number;
  week_number: number;
  picked_home: boolean;
  predicted_margin: number;
  home_abbr: string;
  away_abbr: string;
  kickoff_at: string; // ISO-8601 (UTC)
  status: "scheduled" | "in_progress" | "final";
  home_score: number | null;
  away_score: number | null;

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid WeekPicksRow (not an object)");
    if (!isNumber(data.pigeon_number)) throw new DataValidationError("pigeon_number must be number");
    if (!isString(data.pigeon_name)) throw new DataValidationError("pigeon_name must be string");
    if (!isNumber(data.game_id)) throw new DataValidationError("game_id must be number");
    if (!isNumber(data.week_number)) throw new DataValidationError("week_number must be number");
    if (!isBoolean(data.picked_home)) throw new DataValidationError("picked_home must be boolean");
    if (!isNumber(data.predicted_margin)) throw new DataValidationError("predicted_margin must be number");
    if (!isString(data.home_abbr)) throw new DataValidationError("home_abbr must be string");
    if (!isString(data.away_abbr)) throw new DataValidationError("away_abbr must be string");
    if (!isString(data.kickoff_at)) throw new DataValidationError("kickoff_at must be string");

    if (!isString(data.status)) throw new DataValidationError("status must be string");
    const status = data.status as string;
    if (!["scheduled", "in_progress", "final"].includes(status)) {
      throw new DataValidationError("status must be one of scheduled|in_progress|final");
    }

    const hs = data.home_score;
    const as = data.away_score;
    if (!(hs === null || typeof hs === "number")) throw new DataValidationError("home_score must be number|null");
    if (!(as === null || typeof as === "number")) throw new DataValidationError("away_score must be number|null");

    this.pigeon_number = data.pigeon_number;
    this.pigeon_name = data.pigeon_name;
    this.game_id = data.game_id;
    this.week_number = data.week_number;
    this.picked_home = data.picked_home;
    this.predicted_margin = data.predicted_margin;
    this.home_abbr = data.home_abbr;
    this.away_abbr = data.away_abbr;
    this.kickoff_at = data.kickoff_at;
    this.status = status as WeekPicksRow["status"];
    this.home_score = hs ?? null;
    this.away_score = as ?? null;
  }
}

/** Leaderboard row for one week (lower score is better). */
export class LeaderboardRow {
  pigeon_number: number;
  pigeon_name: string;
  week_number: number;
  score: number;
  rank: number;
  points: number;

  constructor(data: unknown) {
    if (!isRecord(data)) throw new DataValidationError("Invalid LeaderboardRow (not an object)");
    if (!isNumber(data.pigeon_number)) throw new DataValidationError("pigeon_number must be number");
    if (!isString(data.pigeon_name)) throw new DataValidationError("pigeon_name must be string");
    if (!isNumber(data.week_number)) throw new DataValidationError("week_number must be number");
    if (!isNumber(data.score)) throw new DataValidationError("score must be number");
    if (!isNumber(data.rank)) throw new DataValidationError("rank must be number");
    if (!isNumber(data.points)) throw new DataValidationError("points must be number");

    this.pigeon_number = data.pigeon_number;
    this.pigeon_name = data.pigeon_name;
    this.week_number = data.week_number;
    this.score = data.score;
    this.rank = data.rank;
    this.points = data.points;
  }
}

