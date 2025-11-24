// =============================================
// File: src/pages/AdminPage.tsx
// Tabs wrapper + nested routes for Locks/Picks and Roster
// =============================================
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Tabs, Tab } from "@mui/material";
import { PageScroll } from "../components/Layout";

export default function AdminPage() {
  const { pathname } = useLocation();
  const value = pathname.endsWith("/pigeons") ? "pigeons" : "picks";

  return (
    <PageScroll>
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
    </PageScroll>
  );
}
