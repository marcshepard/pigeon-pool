/**
 * Admin Page for Andy
 */

import { Typography, Box } from "@mui/material";

export default function AdminPage() {
  return (
    <Box maxWidth={800} mx="auto" >
        <Typography variant="body1" align="center" fontWeight="bold" mb={2}>
            Admin page (placeholder)
        </Typography>
        <Typography variant="body1">
            Hey Andy - only you can see this page. It will eventually contain whatever you say you'll need next year to use this app to run the pool. That likely includes:
        </Typography>
        <ul>
            <li>View picks before they are locked (for quality control)</li>
            <li>Pick on behalf of (in case someone is having trouble submitting their picks)</li>
        </ul>
    </Box>
  );
}