#!/usr/bin/env bash
# Runs unit tests + e2e tests sequentially, prints a clean summary.
# Designed to be the single command a reviewer runs to verify the suite.

set +e

# ANSI colors only if stdout is a TTY (so CI / piped output stays clean).
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'
  RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi

bar() {
  printf "${CYAN}${BOLD}═════════════════════════════════════════════════════════════════${RESET}\n"
}

thin_bar() {
  printf "${CYAN}─────────────────────────────────────────────────────────────────${RESET}\n"
}

START=$(date +%s)

printf "\n"
bar
printf "${CYAN}${BOLD}  IssueFlow — Full Test Suite${RESET}\n"
bar
printf "\n"
printf "${YELLOW}Runs unit tests + e2e tests. Wall-clock: ~75-120s on a warm machine.${RESET}\n"
printf "${YELLOW}E2E boots an ephemeral Postgres via Testcontainers — Docker must be running.${RESET}\n\n"

# --- 1/2: Unit tests ---
printf "${CYAN}${BOLD}[1/2] Unit tests${RESET}\n"
thin_bar
npm test
UNIT_RESULT=$?
printf "\n"

# --- 2/2: E2E tests ---
printf "${CYAN}${BOLD}[2/2] E2E tests (boots Postgres container — please wait)${RESET}\n"
thin_bar
npm run test:e2e
E2E_RESULT=$?
printf "\n"

END=$(date +%s)
ELAPSED=$((END - START))
MIN=$((ELAPSED / 60))
SEC=$((ELAPSED % 60))

# --- Summary ---
bar
printf "${CYAN}${BOLD}  SUMMARY${RESET}\n"
bar
printf "\n"
printf "  Wall time:  %dm %ds (%ds total)\n" "$MIN" "$SEC" "$ELAPSED"
if [ "$UNIT_RESULT" -eq 0 ]; then
  printf "  Unit tests: ${GREEN}${BOLD}PASS${RESET}\n"
else
  printf "  Unit tests: ${RED}${BOLD}FAIL${RESET}\n"
fi
if [ "$E2E_RESULT" -eq 0 ]; then
  printf "  E2E tests:  ${GREEN}${BOLD}PASS${RESET}\n"
else
  printf "  E2E tests:  ${RED}${BOLD}FAIL${RESET}\n"
fi
printf "\n"

if [ "$UNIT_RESULT" -eq 0 ] && [ "$E2E_RESULT" -eq 0 ]; then
  printf "${GREEN}${BOLD}All tests passed.${RESET}\n\n"
  exit 0
else
  printf "${RED}${BOLD}One or more test phases failed.${RESET}\n"
  if [ "$E2E_RESULT" -ne 0 ] && [ "$UNIT_RESULT" -eq 0 ]; then
    printf "\n${YELLOW}Only e2e failed — there's a documented ~5%% flake rate from cross-spec${RESET}\n"
    printf "${YELLOW}contamination. Try once more before investigating; if it fails again,${RESET}\n"
    printf "${YELLOW}check the failed test name in the e2e output above.${RESET}\n"
  fi
  printf "\n"
  exit 1
fi
