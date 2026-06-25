import { useEffect, useState } from "react";
import { Alert, Box, Button, Divider, Stack, TextField, Typography } from "@mui/material";
import { adminUpdateLeague, adminPutPayouts, getPayouts } from "../../backend/fetch";
import { useAuth } from "../../auth/useAuth";
import { useAppCache } from "../../hooks/useAppCache";
import type { PayoutRow } from "../../backend/types";

export default function AdminSettings() {
  const { me, refresh } = useAuth();
  const currentName = me?.activeTenant?.name ?? "";
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await adminUpdateLeague(name.trim());
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
        {saved && <Alert severity="success">Saved.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !name.trim() || name.trim() === currentName}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </Box>
      </Stack>

      <Divider sx={{ my: 4 }} />
      <PayoutsEditor />
    </Box>
  );
}

function PayoutsEditor() {
  const cacheGetPayouts = useAppCache((s) => s.getPayouts);
  const cacheSetPayouts = useAppCache((s) => s.setPayouts);

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

  const prizePool = rows.reduce((sum, r) => sum + r.points, 0) * 19;

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

  if (loading) return <Typography variant="body2" color="text.secondary">Loading payouts…</Typography>;

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Payouts</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Prize amounts paid for each finishing place. The prize pool is the sum × 19 entries.
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
          />
        ))}
        <Typography variant="body2" color="text.secondary">
          Prize pool: ${prizePool.toLocaleString()}
        </Typography>
        {saved && <Alert severity="success">Saved.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Button variant="contained" onClick={handleSave} disabled={saving || rows.length === 0}>
            {saving ? "Saving…" : "Save payouts"}
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
