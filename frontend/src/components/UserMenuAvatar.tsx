import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  Menu,
  MenuItem,
  IconButton,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { Me } from "../backend/types";
import { renamePigeon, setPrimaryPigeon } from "../backend/fetch";

export interface UserMenuAvatarProps {
  user: Me;
  onSignOut: () => void;
  onSwitchTenant: (tenant_id: number) => Promise<void>;
  onRenamed: () => Promise<void>;
}

/**
 * Avatar with dropdown menu for user info, tenant switching, and sign out.
 */
export default function UserMenuAvatar({ user, onSignOut, onSwitchTenant, onRenamed }: UserMenuAvatarProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const open = Boolean(anchorEl);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };
  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const activeTenant = user.activeTenant;
  const otherTenants = user.available_tenants.filter((t) => t.tenant_id !== user.tenant_id);
  const myPigeons = [
    { player_id: user.player_id, pigeon_number: user.pigeon_number, pigeon_name: user.pigeon_name },
    ...user.alternates,
  ];
  const canRename = activeTenant?.pigeons_can_rename ?? false;

  return (
    <>
      <Tooltip title={user.pigeon_name}>
        <IconButton onClick={handleMenuOpen} size="small" sx={{ ml: 2 }}>
          <Avatar>{user.pigeon_name[0]}</Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleMenuClose}
        onClick={handleMenuClose}
        PaperProps={{
          elevation: 2,
          sx: { mt: 1.5, minWidth: 200 },
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem disabled>
          <strong>{user.pigeon_name}</strong>
        </MenuItem>
        <MenuItem disabled>Pigeon #{user.pigeon_number}</MenuItem>
        <MenuItem disabled>{user.email}</MenuItem>

        {activeTenant && (
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              Pool: {activeTenant.name} ({activeTenant.role})
            </Typography>
          </MenuItem>
        )}

        {canRename && <MenuItem onClick={() => setRenameOpen(true)}>Rename pigeon…</MenuItem>}
        {myPigeons.length > 1 && (
          <MenuItem onClick={() => setPrimaryOpen(true)}>Set default pigeon…</MenuItem>
        )}

        {otherTenants.length > 0 && <Divider />}
        {otherTenants.map((t) => (
          <MenuItem
            key={t.tenant_id}
            onClick={() => {
              handleMenuClose();
              onSwitchTenant(t.tenant_id);
            }}
          >
            Switch to: {t.name}
          </MenuItem>
        ))}

        <Divider />
        <MenuItem onClick={onSignOut}>Sign out</MenuItem>
      </Menu>

      <RenamePigeonDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        pigeons={myPigeons}
        onSaved={onRenamed}
      />
      <PrimaryPigeonDialog
        open={primaryOpen}
        onClose={() => setPrimaryOpen(false)}
        pigeons={myPigeons}
        currentPlayerId={user.player_id}
      />
    </>
  );
}

function PrimaryPigeonDialog({
  open,
  onClose,
  pigeons,
  currentPlayerId,
}: {
  open: boolean;
  onClose: () => void;
  pigeons: PigeonOption[];
  currentPlayerId: number;
}) {
  const [defaultPlayerId, setDefaultPlayerId] = useState(currentPlayerId);
  const [playerId, setPlayerId] = useState(currentPlayerId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaultPlayerId(currentPlayerId);
    setPlayerId(currentPlayerId);
  }, [currentPlayerId]);

  useEffect(() => {
    if (open) {
      setSaving(false);
      setSaved(false);
      setError(null);
    }
  }, [open]);

  const close = () => {
    setPlayerId(defaultPlayerId);
    onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setPrimaryPigeon(playerId);
      setDefaultPlayerId(playerId);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : close} maxWidth="xs" fullWidth>
      <DialogTitle>Set default pigeon</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl fullWidth disabled={saving || saved}>
            <InputLabel>Pigeon</InputLabel>
            <Select
              label="Pigeon"
              value={playerId}
              onChange={(e) => setPlayerId(Number(e.target.value))}
            >
              {pigeons.map((pigeon) => (
                <MenuItem key={pigeon.player_id} value={pigeon.player_id}>
                  #{pigeon.pigeon_number} – {pigeon.pigeon_name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary">
            This pigeon will be selected by default the next time you sign in. Existing sessions are unchanged.
          </Typography>
          {saved && <Alert severity="success">Default pigeon saved.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {saved ? (
          <Button variant="contained" onClick={close}>Done</Button>
        ) : (
          <>
            <Button onClick={close} disabled={saving}>Cancel</Button>
            <Button variant="contained" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

interface PigeonOption {
  player_id: number;
  pigeon_number: number;
  pigeon_name: string;
}

function RenamePigeonDialog({
  open,
  onClose,
  pigeons,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  pigeons: PigeonOption[];
  onSaved: () => Promise<void>;
}) {
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const first = pigeons[0];
      setPlayerId(first?.player_id ?? null);
      setName(first?.pigeon_name ?? "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handlePigeonChange = (pid: number) => {
    setPlayerId(pid);
    setName(pigeons.find((p) => p.player_id === pid)?.pigeon_name ?? "");
    setError(null);
  };

  const handleSave = async () => {
    if (playerId == null) return;
    setSaving(true);
    setError(null);
    try {
      await renamePigeon(playerId, name.trim());
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Rename Pigeon</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {pigeons.length > 1 && (
            <FormControl size="small">
              <InputLabel>Pigeon</InputLabel>
              <Select
                label="Pigeon"
                value={playerId ?? ""}
                onChange={(e) => handlePigeonChange(Number(e.target.value))}
                disabled={saving}
              >
                {pigeons.map((p) => (
                  <MenuItem key={p.player_id} value={p.player_id}>
                    #{p.pigeon_number} – {p.pigeon_name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <TextField
            autoFocus
            label="New name"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            disabled={saving}
            inputProps={{ maxLength: 30 }}
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
