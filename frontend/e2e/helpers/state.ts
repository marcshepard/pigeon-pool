import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestTenantState {
  tenant_id: number;
  player_id: number;
  user_id: number;
  user_email: string;
  user_password: string;
  auth_token: string;
  scored_game_ids: number[];
  scored_week: number;
  submission_game_id: number;
  submission_week: number;
  synthetic_game_ids: number[];
}

export interface SnapshotState {
  tenant_id: number | null;
  auth_token: string | null;
  scored_week: number;
}

export interface TestState {
  has_real_games: boolean;
  test: TestTenantState;
  snapshot: SnapshotState;
}

let _cache: TestState | null = null;

export function getState(): TestState {
  if (!_cache) {
    const p = path.resolve(__dirname, "../../../playwright/.test-state.json");
    _cache = JSON.parse(readFileSync(p, "utf-8")) as TestState;
  }
  return _cache;
}
