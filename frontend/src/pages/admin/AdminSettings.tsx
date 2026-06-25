import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { adminUpdateLeague } from "../../backend/fetch";
import { useAuth } from "../../auth/useAuth";

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
    </Box>
  );
}
