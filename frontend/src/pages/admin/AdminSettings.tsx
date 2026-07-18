import { useEffect, useState } from "react";
import { Alert, Box, Button, Divider, FormControlLabel, Stack, Switch, TextField, Typography } from "@mui/material";
import { adminUpdateLeague, adminPutPayouts, getPayouts, getPoolInfo } from "../../backend/fetch";
import { useAuth } from "../../auth/useAuth";
import { useAppCache } from "../../hooks/useAppCache";
import type { PayoutRow } from "../../backend/types";

export default function AdminSettings() {
  const { me, refresh } = useAuth();
  const currentName = me?.activeTenant?.name ?? "";
  const currentPigeonsCanRename = me?.activeTenant?.pigeons_can_rename ?? true;
  const [name, setName] = useState(currentName);
  const [pigeonsCanRename, setPigeonsCanRename] = useState(currentPigeonsCanRename);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await adminUpdateLeague({ name: name.trim(), pigeons_can_rename: pigeonsCanRename });
      await refresh();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box maxWidth={480}>
      <Typography variant="h6" gutterBottom>
        League Settings
      </Typography>
      <Stack spacing={2}>
        <TextField
          label="League name"
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          fullWidth
          disabled={saving}
        />
        <FormControlLabel
          control={
            <Switch
              checked={pigeonsCanRename}
              onChange={(e) => { setPigeonsCanRename(e.target.checked); setSaved(false); }}
              disabled={saving}
            />
          }
          label="Allow pigeons to rename themselves"
        />
        {saved && <Alert severity="success">Saved.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !name.trim() || (name.trim() === currentName && pigeonsCanRename === currentPigeonsCanRename)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </Box>
      </Stack>

      <Divider sx={{ my: 4 }} />
      <ReturnsEditor />
    </Box>
  );
}

function validateReturns(rows: PayoutRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].points < 0) {
      errors[rows[i].place] = "Must be ≥ 0";
    } else if (i > 0 && rows[i].points > rows[i - 1].points) {
      errors[rows[i].place] = `Must not exceed ${ordinal(rows[i - 1].place)} place (${rows[i - 1].points})`;
    }
  }
  return errors;
}

function ReturnsEditor() {
  const cacheGetPayouts = useAppCache((s) => s.getPayouts);
  const cacheSetPayouts = useAppCache((s) => s.setPayouts);
  const cacheGetPoolInfo = useAppCache((s) => s.getPoolInfo);
  const cacheSetPoolInfo = useAppCache((s) => s.setPoolInfo);
  const pigeonCount = useAppCache((s) => s.poolInfo?.data.pigeon_count ?? null);

  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = cacheGetPayouts();
    if (cached) {
      setRows(cached);
      setLoading(false);
      return;
    }
    getPayouts()
      .then((data) => {
        cacheSetPayouts(data);
        setRows(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [cacheGetPayouts, cacheSetPayouts]);

  useEffect(() => {
    if (cacheGetPoolInfo()) return;
    getPoolInfo()
      .then((d) => cacheSetPoolInfo(d))
      .catch(() => {/* non-fatal */});
  }, [cacheGetPoolInfo, cacheSetPoolInfo]);

  const totalSeasonReturn = rows.reduce((sum, r) => sum + r.points, 0) * 19;
  const avgPerPigeon = pigeonCount ? Math.round(totalSeasonReturn / pigeonCount) : null;
  const fieldErrors = validateReturns(rows);
  const hasErrors = Object.keys(fieldErrors).length > 0;

  const handlePointsChange = (place: number, raw: string) => {
    const n = parseInt(raw.replace(/\D/g, "") || "0", 10);
    setRows((prev) => prev.map((r) => r.place === place ? { ...r, points: n } : r));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await adminPutPayouts(rows);
      cacheSetPayouts(rows);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Typography variant="body2" color="text.secondary">Loading returns…</Typography>;

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Returns</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Return amounts for each finishing place. Leave blank if a given place doesn't have a return.
      </Typography>
      <Stack spacing={1.5} maxWidth={280}>
        {rows.map((r) => (
          <TextField
            key={r.place}
            label={`${ordinal(r.place)} place`}
            value={r.points || ""}
            onChange={(e) => handlePointsChange(r.place, e.target.value)}
            size="small"
            inputProps={{ inputMode: "numeric", pattern: "\\d*" }}
            disabled={saving}
            error={!!fieldErrors[r.place]}
            helperText={fieldErrors[r.place]}
          />
        ))}
        <Typography variant="body2" color="text.secondary">
          Total season return: {totalSeasonReturn.toLocaleString()}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Per pigeon return: {avgPerPigeon != null ? avgPerPigeon.toLocaleString() : "—"}
        </Typography>
        {saved && <Alert severity="success">Saved.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Button variant="contained" onClick={handleSave} disabled={saving || rows.length === 0 || hasErrors}>
            {saving ? "Saving…" : "Save returns"}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
