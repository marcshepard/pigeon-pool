/**
 * Home page component.
 */

import { Typography, Box, Stack, Paper } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import EditNoteIcon from "@mui/icons-material/EditNote";
import ListAltIcon from "@mui/icons-material/ListAlt";
import EmojiEventsIcon from "@mui/icons-material/EmojiEvents";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import BarChartIcon from "@mui/icons-material/BarChart";

const tiles = [
    {
        path: "/enter-picks",
        icon: <EditNoteIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Enter Picks",
        desc: "Enter picks for an upcoming week",
    },
    {
        path: "/picks-and-results",
        icon: <ListAltIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Picks and Results",
        desc: "View the picksheet and results for this or a previous week",
    },
    {
        path: "/analytics",
        icon: <BarChartIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Analytics",
        desc: "Analyze your picks and outcome possibilities",
    },
    {
        path: "/year-to-date",
        icon: <EmojiEventsIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Year-to-Date",
        desc: "View the year-to-date leaderboard",
    },
    {
        path: "/about",
        icon: <InfoOutlinedIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "About",
        desc: "Read the rules",
    },
];

export default function HomePage() {
    return (
        <Box sx={{ maxWidth: 520, mx: "auto" }}>
            <Typography variant="body1" align="center" fontWeight="bold">
                Welcome to the Pigeon Pool
            </Typography>
            <Stack spacing={3} mt={5}>
                {tiles.map((tile) => (
                                <Paper
                                    key={tile.path}
                                    elevation={4}
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        p: 2.5,
                                        borderRadius: 3,
                                        boxShadow: 3,
                                        transition: "box-shadow 0.2s, transform 0.2s",
                                        cursor: "pointer",
                                        '&:hover': {
                                            boxShadow: 8,
                                            transform: "translateY(-2px) scale(1.02)",
                                            backgroundColor: (theme) => theme.palette.action.hover,
                                        },
                                        textDecoration: "none",
                                        color: "inherit",
                                    }}
                                    component={RouterLink}
                                    to={tile.path}
                                >
                        <Box sx={{ mr: 2, flexShrink: 0 }}>{tile.icon}</Box>
                        <Box>
                            <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
                                {tile.label}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                {tile.desc}
                            </Typography>
                        </Box>
                    </Paper>
                ))}
            </Stack>
        </Box>
    );
}