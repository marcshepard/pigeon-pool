import { useState } from "react";
import { Avatar, Menu, MenuItem, IconButton, Tooltip } from "@mui/material";
import type { Me } from "../backend/types";

export interface UserMenuAvatarProps {
  user: Me;
  onSignOut: () => void;
}

/**
 * Avatar with dropdown menu for user info and sign out.
 */
export default function UserMenuAvatar({ user, onSignOut }: UserMenuAvatarProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };
  const handleMenuClose = () => {
    setAnchorEl(null);
  };

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
          sx: { mt: 1.5, minWidth: 180 },
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem disabled>
          <strong>{user.pigeon_name}</strong>
        </MenuItem>
        <MenuItem disabled>Pigeon #{user.pigeon_number}</MenuItem>
        <MenuItem disabled>{user.email}</MenuItem>
        <MenuItem onClick={onSignOut}>Sign out</MenuItem>
      </Menu>
    </>
  );
}
