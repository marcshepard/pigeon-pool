// =============================================
// File: src/pages/AdminPage.tsx
// Tabs wrapper + nested routes for Locks/Picks and Roster
// =============================================
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Box, Tabs, Tab } from "@mui/material";

export default function AdminPage() {
  const { pathname } = useLocation();
  const value = pathname.endsWith("/pigeons") ? "pigeons" : "picks";

  return (
    <Box maxWidth={1200} mx="auto" px={{ xs: 2, md: 3 }}>
  <Tabs value={value} sx={{ mb: 2 }} centered>
        <Tab
          value="picks"
          label="Picks"
          component={NavLink}
          to="/admin/picks"
        />
        <Tab
          value="pigeons"
          label="Pigeons"
          component={NavLink}
          to="/admin/pigeons"
        />
      </Tabs>
      <Outlet />
    </Box>
  );
}
