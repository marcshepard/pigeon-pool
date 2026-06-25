import { useState } from "react";
import { Avatar, Divider, Menu, MenuItem, IconButton, Tooltip, Typography } from "@mui/material";
import type { Me } from "../backend/types";

export interface UserMenuAvatarProps {
  user: Me;
  onSignOut: () => void;
  onSwitchTenant: (tenant_id: number) => Promise<void>;
}

/**
 * Avatar with dropdown menu for user info, tenant switching, and sign out.
 */
export default function UserMenuAvatar({ user, onSignOut, onSwitchTenant }: UserMenuAvatarProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };
  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const activeTenant = user.activeTenant;
  const otherTenants = user.available_tenants.filter((t) => t.tenant_id !== user.tenant_id);

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
    </>
  );
}
