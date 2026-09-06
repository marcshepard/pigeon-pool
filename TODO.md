# Post-season priorities

## High priority: Move the backend to Azure App Service Python 3.14

The production backend currently uses Azure's managed Python 3.12 runtime, whose
underlying Debian 11 image reached end-of-life on August 31, 2026. CrowdSignal
submission depends on Playwright/Chromium and therefore needs Linux libraries at
startup. `backend/startup.sh` contains a temporary Debian-11-specific workaround
that disables its unavailable security repository before installing those
libraries.

After the season, test the backend in a deployment slot or temporary App Service
on Azure Python 3.14. Azure's newer Python 3.14 stack uses Ubuntu LTS. Verify
database migrations, sign-in, scheduler, email, and a real CrowdSignal submission
before switching production. Once production is on the newer runtime, remove the
Debian 11 repository workaround and reassess the pinned Playwright version.

## Secondary: Surface native dependency failures automatically

The startup script already installs and one-time launch-tests Chromium. Preserve
the result as a cached runtime status and expose it through a fast health-check
mode (for example, `/ping?require_crowdsignal=true`) that does not rerun a
browser test on each request. Have the backend GitHub Actions workflow require
that mode after deployment, so a failed Chromium install or launch makes the
deployment visibly fail. Configure the Azure Application Insights availability
test to check the same mode and alert after a later container restart.

Extend this single cached readiness status with capability checks only when a
future dependency actually needs an operating-system library; test the useful
behavior (for example, launch Chromium), not individual `.so` library names.
