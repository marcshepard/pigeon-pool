/**
 * Reusable layout primitives for consistent scrolling, sizing, and alerts.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Mental model for what each primitive does:
 * - <Viewport>            : Owns the real viewport height (100dvh) + safe areas.
 * - <AppShell>            : Defined Header / content page / (optional) footer areas. Content takes the remaining height.
 * - <PageScroll>          : Content page scrolls
 * - <PageFit>             : Content page doesn't scroll; but an inner area can grow to available height
 * - <PageFit.ScrollArea>  : Within a PageFit page, a single component can grow to fill available height and scroll after that
 * - <StackColumn>         : Minimal flex "plumbing" to let descendants scroll (see below for details).
 *
 * How these components are used:
 * - Top level App wraps everything in <Viewport> and <AppShell (with header/nav control as Header)>
 * - Top level App wraps alerts in <PageBand>
 * - Each displayed page wraps it's content in either <PageScroll> (most pages) or <PageFit> (currently just the chat pages)
 * - PageFit pages should have exactly one PageFit.ScrollArea child that uses available space before scrolling (currently chat text)
 * - In some rare cases, StackColumn is used to pass down display:flex; flexDirection:column; minHeight:0; to the children
 *   This is required for proper scrolling, and in most cases PageScroll/PageFit/PageFit.ScrollArea handle this properly, but there
 *   we are a few additional places this is needed (per below)
  *
 * Overall usage:
 *   <Viewport>
 *     <AppShell header={<Nav/>}>
 *
 *       // For most pages
 *       <PageScroll>
 *         <Content/>
 *       </PageContainer>
 *
 *       // For the chat pages
 *       <PageFit>
 *         <FixedContent/>
 *         <PageFit.ScrollArea>
 *           <ContentThatGrowsAndScrollsWhenFull/> // Chat messages
 *         </PageFit.ScrollArea>
 *       </PageFit>
 *     </AppShell>
 *   </Viewport>
 * 
 * With a few instances of StackColumn sprinkled in Coach.tsx and ResponsiveNav.tsx to make things work.
 */

import { Box, type BoxProps } from "@mui/material";
import { type ReactNode, useEffect } from "react";

/**
 * Viewport - Own the *real* viewport height across iOS/Android/desktop + safe areas.
 *
 * The entire app is wrapped in this component.
 **/
export function Viewport(props: BoxProps) {
  useEffect(() => {
    const applyVh = () => {
      const supportsDVH = CSS?.supports?.("height: 100dvh");
      if (!supportsDVH) {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty("--vh", `${vh}px`);
      }
    };
    applyVh();
    window.addEventListener("resize", applyVh);
    return () => window.removeEventListener("resize", applyVh);
  }, []);

  return (
    <Box
      {...props}
      sx={{
        position: 'fixed',
        inset: 0,
        display: "flex",
        flexDirection: "column",
        // Prefer dynamic viewport on modern browsers; fallback for iOS Safari
        height: '100dvh',
        ["@supports not (height: 100dvh)"]: {
          height: "calc(var(--vh, 1vh) * 100)",
        },
        // Respect notches and home indicator
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        ...props.sx,
      }}
    />
  );
}

/**
 * AppShell - Header / content / footer layout wrapper.
 * 
 * Header Control goes on top. Footer on the bottom (not currently used).
 * Content in the middle, which dynamically grows to fill the ViewPort height
 */
type AppShellProps = {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode; // the page
};
export function AppShell({ header, footer, children }: AppShellProps) {
  return (
    <Box sx={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0
    }}>
      {header ? <Box sx={{ flex: "0 0 auto" }}>{header}</Box> : null}
      <Box sx={{
        flex: "1 1 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column"
      }}>
        {children}
      </Box>
      {footer ? <Box sx={{ flex: "0 0 auto" }}>{footer}</Box> : null}
    </Box>
  );
}

/**
 * StackColumn - StackColumn — minimal flex "plumbing" for vertical stacks.
 * 
 * Applies: display:flex; flex-direction:column;
 *   flex: 1 1 auto; // can grow but also shrink (so children can scroll)
 *   min-height: 0; min-width: 0; // critical: allows descendant overflow/scroll
 *
 * Use when:
 * * You need a generic column wrapper that won't block a child <Box overflowY="auto">.
 * * You're building nav/content shells or placing a scroller a few levels down.
 * 
 * Don't use when:
 * You also need width constraint and centering — use <PageScroll>/<PageFit> (which wrap <PageFrame>).
 */
export function StackColumn({ sx, ...props }: BoxProps) {
  return (
    <Box
      {...props}
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        minWidth: 0,
        ...sx,
      }}
    />
  );
}

/**
 * PageFrame — wraps routed pages with optional max width constraint.
 */
function PageFrame({
  children,
  sx,
  maxWidth,
  ...props
}: BoxProps & {
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <StackColumn {...props} sx={sx}>
      <Box
        sx={{
          width: "100%",
          maxWidth: maxWidth || "100%",
          mx: "auto",
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          minHeight: 0,
        }}
      >
        {children}
      </Box>
    </StackColumn>
  );
}

/**
 * Full-page container.
 * - scroll=true  → the entire page scrolls (most informational pages).
 * - scroll=false → page fills viewport; use <FillContainer> + <ScrollArea> for inner scrolling.
 */
function PageContainer({
  scroll = false,
  sx,
  ...props
}: BoxProps & { scroll?: boolean }) {
  return (
    <Box
      {...props}
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        ...(scroll ? { overflowY: "auto", overscrollBehavior: "auto" } : { overflow: "hidden" }),
        ...sx,
      }}
    />
  );
}

/** Section that claims remaining height inside a PageContainer. */
function FillContainer({ sx, ...props }: BoxProps) {
  return (
    <Box
      {...props}
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        ...sx,
      }}
    />
  );
}

/**
 * Page that scrolls once it overflows the viewport
 */
export function PageScroll({
  maxWidth,
  ...props
}: BoxProps & { maxWidth?: string }) {
  return (
    <PageFrame maxWidth={maxWidth}>
      <PageContainer scroll {...props} />
    </PageFrame>
  );
}

/**
 * Page that doesn't grow beyond the viewport and has exactly one inner area that grows and scrolls.
 * 
 * IMPORTANT: Should contain exactly one <PageFit.ScrollArea> child to handle the scrolling region.
 */
export function PageFit({
  header,
  footer,
  children,
  maxWidth,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode; // put your scrollable stuff in <PageFit.ScrollArea>
  maxWidth?: string;
}) {
  return (
    <PageFrame maxWidth={maxWidth}>
      <PageContainer>
        {header}
        <FillContainer>{children}</FillContainer>
        {footer}
      </PageContainer>
    </PageFrame>
  );
}

/**
 * The scrolling region inside PageFit - grows to fill available space, then scrolls.
 * Should be used exactly once per PageFit parent.
 */
PageFit.ScrollArea = function PageFitScrollArea(props: BoxProps) {
  return (
    <Box
      {...props}
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        overflowY: "auto",
        overscrollBehavior: "contain",
        ...props.sx,
      }}
    />
  );
};