/**
 * Responsive navigation with AppBar and Drawer using MUI.
 */

import type { ReactNode } from "react";
import { useState, useMemo } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import {
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  useMediaQuery,
  useTheme,
  Divider,
} from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";
import MenuIcon from "@mui/icons-material/Menu";
import SportsFootballIcon from "@mui/icons-material/SportsFootball";

// ---- Types ----
export type NavItem = {
  path: string;
  label: string;
  icon?: "home" | "picks";
};

type ResponsiveNavProps = {
  title: string;          // Page title shown in the app bar
  brand: ReactNode;       // Brand element (e.g., logo) to show over the drawer
  navItems: NavItem[];
  userMenu: ReactNode;    // Avatar/menu to show on the right of the AppBar
  children: ReactNode;    // Main page content
};

// ---- Constants ----
const DRAWER_WIDTH_PX = 280;

// Simple icon map using MUI icons
function ItemIcon({ kind }: { kind?: NavItem["icon"] }) {
  if (kind === "picks") return <SportsFootballIcon fontSize="small" />;
  return <HomeIcon fontSize="small" />; // default
}

/**
 * Responsive left nav with AppBar.
 * - Permanent Drawer on md+ screens
 * - Temporary Drawer (hamburger) on sm screens
 * - Uses MUI spacing, no rems, no extra icon libs
 */
export default function ResponsiveNav({
  title,
  brand,
  navItems,
  userMenu,
  children,
}: ResponsiveNavProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });

  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const items: NavItem[] = useMemo(
    () =>
      navItems && navItems.length
        ? navItems
        : [
            { path: "/", label: "Home", icon: "home" },
            { path: "/picks", label: "Enter Picks", icon: "picks" },
          ],
    [navItems]
  );

  const drawerContent = (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
      }}
      role="presentation"
    >
      {/* Brand at top (clickable to Home) */}
      <Box
        component={Link}
        to="/"
        onClick={() => setOpen(false)}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          px: 2,
          py: 2,
          textDecoration: "none",
          color: "inherit",
        }}
      >
        {brand}
      </Box>

      <Divider />

      <List sx={{ flex: 1, px: 1 }}>
        {items.map((item) => {
          const selected = location.pathname === item.path;
          return (
            <ListItemButton
              key={item.path}
              selected={selected}
              onClick={() => {
                navigate(item.path);
                setOpen(false);
              }}
              sx={{
                borderRadius: 2,
                my: 0.5,
                "&.Mui-selected": {
                  bgcolor: "action.selected",
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <ItemIcon kind={item.icon} />
              </ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );



  return (
    <Box sx={{ display: "flex", minHeight: "100dvh" }}>
      {/* Desktop: permanent drawer */}
      {isDesktop && (
        <Drawer
          variant="permanent"
          open
          sx={{
            width: DRAWER_WIDTH_PX,
            flexShrink: 0,
            "& .MuiDrawer-paper": {
              width: DRAWER_WIDTH_PX,
              boxSizing: "border-box",
              borderRight: `1px solid ${theme.palette.divider}`,
            },
          }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* Mobile: temporary drawer */}
      {!isDesktop && (
        <Drawer
          variant="temporary"
          open={open}
          onClose={() => setOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            "& .MuiDrawer-paper": {
              width: DRAWER_WIDTH_PX,
              boxSizing: "border-box",
            },
          }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* Main column */}
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <AppBar
          position="sticky"
          elevation={0}
          color="default"
          sx={{
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <Toolbar sx={{ minHeight: 56, px: 2, gap: 1 }}>
            {!isDesktop && (
              <IconButton
                color="inherit"
                edge="start"
                onClick={() => setOpen(true)}
                aria-label="Open navigation"
              >
                <MenuIcon />
              </IconButton>
            )}
            <Typography
              variant="h6"
              component="div"
              sx={{ flex: 1, textAlign: { xs: "center", md: "left" } }}
            >
              {title ?? items.find(i => i.path === location.pathname)?.label ?? "Pigeon Pool"}
            </Typography>
            {userMenu}
          </Toolbar>
        </AppBar>

        {/* Page content */}
        <Box
          component="main"
          sx={{
            width: "100%",
            mx: "auto",
            boxSizing: "border-box",
            p: { xs: 2, md: 3 },
            maxWidth: 1200,
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
