import { ActionPanel, Action, List, showToast, Toast, Icon, environment } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import React from "react";
import { homedir } from "node:os";
import { join } from "path";
import { exec } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import { existsSync, statSync } from "fs";
import initSqlJs, { type Database } from "sql.js";
import { URL } from "url";
import Fuse from "fuse.js";

const execPromise = promisify(exec);

interface Tab {
  id: string;
  windowId: number;
  tabIndex: number;
  title: string;
  url: string;
}

interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  lastVisited: number;
}

async function runAppleScript(script: string): Promise<string> {
  try {
    // Escape single quotes within the script for the shell command
    const escapedScript = script.replace(/'/g, "'\\''");
    const { stdout } = await execPromise(`osascript -e '${escapedScript}'`);
    return stdout.trim();
  } catch (error: any) {
    console.error("AppleScript Error:", error);
    // Check if Brave is running (error code -1728 or specific message)
    if (
      error instanceof Error &&
      (error.message.includes("Application isn't running") || error.message.includes("-1728"))
    ) {
      console.warn("runAppleScript detected Brave is not running.");
      return "";
    }
    throw error;
  }
}

async function isBraveRunning(): Promise<boolean> {
  const script = `return application "Brave Browser" is running`;
  try {
    const result = await runAppleScript(script);
    // runAppleScript returns "true" or "false" as strings
    return result === "true";
  } catch (error) {
    // If runAppleScript throws (e.g., osascript error), assume not running
    console.error("Error checking if Brave is running:", error);
    return false;
  }
}
async function getOpenTabs(): Promise<Tab[]> {
  // Using JSON output via python3 for robustness
  const jsonScript = `
    set output to "["
    try
      tell application "Brave Browser"
        -- <<< REMOVED 'activate' to prevent launching Brave >>>
        -- Check if running *within* the script for safety, though runAppleScript handles it too
        if not running then error "Brave Browser is not running." number -1728
        set windowList to windows
        set firstWindow to true
        repeat with w in windowList
          set windowId to id of w
          set tabIndex to 0
          set firstTab to true
          try
            set currentTabs to tabs of w
            repeat with t in currentTabs
              if not firstWindow or not firstTab then
                set output to output & ","
              end if
              set firstWindow to false
              set firstTab to false

              set tabIndex to tabIndex + 1
              set tabTitle to title of t
              set tabUrl to URL of t

              -- Use python3 for robust JSON string escaping
              set escapedTitle to do shell script "printf %s " & quoted form of tabTitle & " | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'"
              set escapedUrl to do shell script "printf %s " & quoted form of tabUrl & " | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'"

              set output to output & "{\\"windowId\\":" & windowId & ", \\"tabIndex\\":" & tabIndex & ", \\"title\\":" & escapedTitle & ", \\"url\\":" & escapedUrl & "}"
            end repeat
          on error errMsg number errNum
            -- Ignore errors getting tabs from a specific window (e.g., minimized window?)
             log "Error processing tabs in window " & windowId & ": " & errMsg
          end try
        end repeat
      end tell
    on error errMsg number errNum
      -- Handle cases where Brave might not be scriptable or running
      if errNum is -1728 then
        -- This is expected if Brave isn't running, return empty array signal
        return "[]"
      end if
      log "Error getting windows: " & errMsg
      -- Return empty JSON array on other errors
      return "[]"
    end try
    set output to output & "]"
    return output
  `;

  try {
    const result = await runAppleScript(jsonScript);
    // If runAppleScript returned "" because Brave wasn't running, result will be empty.
    // If the script itself returned "[]", result will be "[]".
    if (!result || result === "[]") return [];
    const tabs = JSON.parse(result) as Omit<Tab, "id">[];
    return tabs.map((tab) => ({ ...tab, id: `${tab.windowId}-${tab.tabIndex}` }));
  } catch (error: any) {
    console.error("Error fetching or parsing tabs:", error);
    // Avoid showing toast if Brave isn't running (handled by runAppleScript/usePromise)
    if (
      !(
        error instanceof Error &&
        (error.message.includes("Application isn't running") || error.message.includes("-1728"))
      )
    ) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to get tabs",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return [];
  }
}

async function switchToTab(windowId: number, tabIndex: number): Promise<void> {
  if (
    typeof windowId !== "number" ||
    typeof tabIndex !== "number" ||
    isNaN(windowId) ||
    isNaN(tabIndex) ||
    tabIndex <= 0
  ) {
    console.error(`Invalid windowId (${windowId}) or tabIndex (${tabIndex}) provided.`);
    await showToast({
      style: Toast.Style.Failure,
      title: "Internal Error",
      message: "Invalid data for switching tab.",
    });
    return;
  }

  // New AppleScript approach: Directly target window by ID
  const script = `
    tell application "Brave Browser"
      -- Only activate if needed (it likely is to switch tabs)
      if not running then
        display notification "Brave is not running." with title "Brave Tab Switch Error"
        error "Brave Browser is not running." number -1728
      end if
      activate -- Make sure Brave is frontmost

      -- Check if the window exists first
      if exists (window id ${windowId}) then
        set targetWindow to window id ${windowId}

        -- Bring the window to the front
        -- Setting index to 1 makes it the frontmost window
        set index of targetWindow to 1

        -- Set the active tab using its index
        -- Ensure the tab index is valid for the window (AppleScript might error otherwise)
        try
          set active tab index of targetWindow to ${tabIndex}
        on error errMsg number errNum
          log "Error setting active tab index ${tabIndex} for window id ${windowId}: " & errMsg
          display notification "Could not switch to the specific tab." with title "Brave Tab Switch Error"
        end try
      else
        log "Window with ID ${windowId} not found. It might have been closed."
        display notification "Could not find the target window." with title "Brave Tab Switch Error"
      end if
    end tell
  `;

  try {
    await runAppleScript(script);
  } catch (error: any) {
    console.error("Error switching tab:", error);
    // runAppleScript now handles the "not running" case more gracefully,
    // but we might still get errors here if activation fails later.
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to switch tab",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function openUrlInNewTab(url: string): Promise<void> {
  // Ensure URL has a scheme for AppleScript's `open location` or `make new tab`
  let fullUrl = url;
  if (!url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)) {
    // Check for any valid scheme
    // If it looks like a domain name or localhost, add https://
    if ((url.includes(".") && !url.includes(" ")) || url.startsWith("localhost")) {
      fullUrl = `https://${url}`;
    } else {
      // If it doesn't look like a URL, delegate to search function
      console.warn(`"${url}" doesn't look like a URL, attempting search instead.`);
      await searchWithBrave(url);
      return;
    }
  }

  // Escape double quotes for AppleScript string literal
  const escapedUrl = fullUrl.replace(/"/g, '\\"');

  const script = `
    tell application "Brave Browser"
      -- Only activate if needed
      if not running then
        -- If not running, just use 'open location' which will launch Brave
        open location "${escapedUrl}"
      else
        activate -- Bring to front if already running
        -- Check if there are any windows open
        if not (exists window 1) then
          -- If no windows, creating a new tab might fail, so open location instead
          open location "${escapedUrl}"
        else
          -- If windows exist, create a new tab in the front window
          tell window 1
            set newTab to make new tab with properties {URL:"${escapedUrl}"}
          end tell
        end if
      end if
    end tell
  `;
  try {
    await runAppleScript(script);
  } catch (error: any) {
    console.error("Error opening URL:", error);
    // Show toast for generic errors, but not specifically for "not running"
    // as the script now attempts to handle that by launching Brave via open location.
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open URL",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function searchWithBrave(query: string): Promise<void> {
  const encodedQuery = encodeURIComponent(query);

  // Construct a search URL (using Google as an example)
  // Note: This won't necessarily use the user's default search engine set in Brave.
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}`;

  // Escape double quotes for the AppleScript string literal
  const escapedSearchUrl = searchUrl.replace(/"/g, '\\"');

  const script = `
    tell application "Brave Browser"
      -- Only activate if needed
      if not running then
        -- If not running, just use 'open location' which will launch Brave
        open location "${escapedSearchUrl}"
      else
        activate -- Bring to front if already running
        -- Check if there are any windows open
        if not (exists window 1) then
          -- If no windows, creating a new tab might fail, so open location directly
          open location "${escapedSearchUrl}"
        else
          -- If windows exist, create a new tab in the front window
          tell window 1
            make new tab with properties {URL:"${escapedSearchUrl}"}
          end tell
          -- Ensure the window with the new tab is frontmost
          set index of window 1 to 1
        end if
      end if
    end tell
  `;
  try {
    await runAppleScript(script);
  } catch (error: any) {
    console.error("Error searching:", error);
    // Show toast for generic errors, but not specifically for "not running"
    // as the script now attempts to handle that by launching Brave via open location.
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to perform search",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Find all valid Brave history database paths
function getBraveProfilePaths(): string[] {
  // Add paths for different Brave versions (Stable, Beta, Nightly) if needed
  const potentialBasePaths = [
    join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/"),
    join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser-Beta/"),
    join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser-Nightly/"),
  ];

  const profileNames = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5"];
  const foundPaths: string[] = []; // Store all found paths

  for (const basePath of potentialBasePaths) {
    for (const profileName of profileNames) {
      const historyPath = join(basePath, profileName, "History");
      if (existsSync(historyPath)) {
        try {
          if (statSync(historyPath).isFile()) {
            console.log("Found history DB at:", historyPath);
            foundPaths.push(historyPath); // Add valid path
          }
        } catch (e) {
          // Ignore errors (e.g., permission denied initially)
          console.warn(`Could not stat ${historyPath}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  if (foundPaths.length === 0) {
    console.warn("No Brave history database found in common locations.");
  }
  return foundPaths; // Return array of all found paths
}

// Chrome/Brave epoch is microseconds since Jan 1, 1601 UTC
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11644473600000000;

function chromeTimeToUnixMs(chromeTime: number): number {
  // Ensure chromeTime is treated as a number
  const timeMicro = Number(chromeTime);
  if (isNaN(timeMicro)) return 0; // Or handle error appropriately
  return Math.floor((timeMicro - CHROME_EPOCH_OFFSET_MICROSECONDS) / 1000);
}

// Variable to hold the initialized sql.js instance
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
// Path to the wasm file within the built extension's assets
// This relies on the build script copying the file correctly.
const wasmPath = join(environment.assetsPath, "sql-wasm.wasm");

async function getHistory(days = 7): Promise<HistoryEntry[]> {
  const historyDbPaths = getBraveProfilePaths(); // Get all paths
  if (historyDbPaths.length === 0) {
    return []; // No profile found
  }

  // Calculate the timestamp threshold in Chrome epoch microseconds
  const nowMs = Date.now();
  const daysAgoMs = nowMs - days * 24 * 60 * 60 * 1000;
  const thresholdChromeTime = daysAgoMs * 1000 + CHROME_EPOCH_OFFSET_MICROSECONDS;

  // Initialize sql.js once if needed
  if (!SQL) {
    console.log("Initializing sql.js...");
    let wasmBinary: Buffer;
    try {
      wasmBinary = await fs.readFile(wasmPath);
    } catch (readErr) {
      console.error(`Failed to read WASM file at ${wasmPath}:`, readErr);
      showToast({ style: Toast.Style.Failure, title: "sql.js Error", message: "Could not read sql-wasm.wasm file." });
      return [];
    }
    SQL = await initSqlJs({ wasmBinary });
    console.log("sql.js initialized.");
  }

  const allHistoryEntries: HistoryEntry[] = [];
  let permissionErrorShown = false; // Flag to show permission error only once

  for (const historyDbPath of historyDbPaths) {
    console.log(`Processing history file: ${historyDbPath}`);
    let db: Database | null = null;
    try {
      // Check permissions for the current path
      await fs.access(historyDbPath, fs.constants.R_OK);

      // Read the current database file
      console.log(`Reading history DB file: ${historyDbPath}`);
      const fileBuffer = await fs.readFile(historyDbPath);
      console.log(`Read ${fileBuffer.byteLength} bytes from ${historyDbPath}.`);

      // Load the database
      db = new SQL.Database(fileBuffer);
      console.log(`Database ${historyDbPath} loaded into sql.js.`);

      // Query explanation:
      // - Select URL, title, and max visit time (most recent visit).
      // - Join 'urls' and 'visits' tables.
      // - Filter visits newer than the threshold.
      // - Filter out non-http/https URLs.
      // - Group by URL info to get the most recent visit per URL.
      // - Order by the most recent visit time descending.
      // - Limit results for performance.
      const query = `
         SELECT
           u.id,
           u.title,
           u.url,
           MAX(v.visit_time) as last_visit_time
         FROM urls u
         JOIN visits v ON u.id = v.url
         WHERE v.visit_time >= ?
           AND (u.url LIKE 'http://%' OR u.url LIKE 'https://%')
         GROUP BY u.id, u.title, u.url
         ORDER BY last_visit_time DESC
         LIMIT 500;
       `;

      const results = db.exec(query, [thresholdChromeTime]);

      if (!results || results.length === 0) {
        console.log(`History query returned no results for ${historyDbPath}.`);
        // Continue to the next profile
      } else {
        const columns = results[0].columns;
        const rows = results[0].values;

        const profileHistoryEntries: HistoryEntry[] = rows.map((row) => {
          const url = row[columns.indexOf("url")] as string;
          const visitTime = chromeTimeToUnixMs(row[columns.indexOf("last_visit_time")] as number);
          const title = row[columns.indexOf("title")] as string | null;
          return {
            id: `${historyDbPath}-${url}-${visitTime}`, // Make ID unique across profiles
            title: title || url,
            url: url,
            lastVisited: visitTime,
          };
        });
        allHistoryEntries.push(...profileHistoryEntries);
        console.log(`Added ${profileHistoryEntries.length} entries from ${historyDbPath}`);
      }
    } catch (error: any) {
      // Handle errors for the specific profile path
      if ((error.code === "EPERM" || error.code === "EACCES") && !permissionErrorShown) {
        console.error(`Permission error accessing ${historyDbPath}:`, error);
        showToast({
          style: Toast.Style.Failure,
          title: "Permission Error",
          message: "Raycast needs Full Disk Access for Brave history. Check System Settings.",
        });
        permissionErrorShown = true; // Show only once
      } else if (
        error.message.includes("database disk image is malformed") ||
        error.message.includes("file is not a database")
      ) {
        console.warn(`History DB error for ${historyDbPath}: ${error.message}`);
        showToast({
          style: Toast.Style.Warning, // Use Warning as it might affect only one profile
          title: "History DB Error",
          message: `Brave history file might be corrupted: ${historyDbPath.split("/").slice(-3).join("/")}`, // Show partial path
        });
      } else if (error.code === "ERR_FS_FILE_TOO_LARGE") {
         console.warn(`History file too large for ${historyDbPath}: ${error.message}`);
         showToast({
           style: Toast.Style.Warning,
           title: "History File Too Large",
           message: `History file too large to load: ${historyDbPath.split("/").slice(-3).join("/")}`,
         });
      } else if (error.code !== "EPERM" && error.code !== "EACCES") { // Avoid redundant permission errors
        console.error(`Error processing ${historyDbPath}:`, error);
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to read history",
          message: `Error for profile ${historyDbPath.split("/").slice(-3).join("/")}: ${error.message}`,
        });
      }
      // Continue to the next profile even if one fails
    } finally {
      // Close the database for the current profile
      if (db) {
        db.close();
        console.log(`sql.js database for ${historyDbPath} closed.`);
      }
    }
  } // End loop through paths

  // Sort the combined list by visit time descending
  allHistoryEntries.sort((a, b) => b.lastVisited - a.lastVisited);

  // Deduplicate based on URL, keeping the most recent entry across all profiles
  const uniqueHistoryEntries = Array.from(
    new Map(allHistoryEntries.map((entry) => [entry.url, entry])).values()
  );

  console.log(`Returning ${uniqueHistoryEntries.length} unique history entries from ${historyDbPaths.length} profiles.`);
  // Return the unique, sorted list
  return uniqueHistoryEntries;
}

function isValidUrl(text: string): boolean {
  if (!text || text.includes(" ")) return false; // Basic sanity check

  // Try parsing with URL constructor
  try {
    // Add protocol if missing for validation, but don't use this modified version for opening
    const urlToTest = text.includes("://") ? text : `https://${text}`;
    new URL(urlToTest);
    return true;
  } catch (_) {
    // Allow scheme-less URLs like example.com, localhost, localhost:port
    // Requires a dot OR is 'localhost' potentially followed by a port
    return text.includes(".") || text.match(/^localhost(:\d+)?$/) !== null;
  }
}

/**
 * Fetches open tabs and/or browsing history from Brave.
 * Shows appropriate toasts based on Brave's running state or errors.
 */
async function fetchBraveData(): Promise<{ tabs: Tab[]; history: HistoryEntry[]; isRunning: boolean }> {
  const isRunning = await isBraveRunning();
  console.log("Checking Brave status. Running:", isRunning);

  let tabs: Tab[] = [];
  let history: HistoryEntry[] = [];
  const historyDays = isRunning ? 365 : 7; // Fetch more history if Brave is running

  if (isRunning) {
    console.log(`Brave is running. Fetching tabs and history (last ${historyDays} days)...`);
    // Use Promise.allSettled to avoid one failing preventing the other
    const results = await Promise.allSettled([getOpenTabs(), getHistory(historyDays)]);

    if (results[0].status === "fulfilled") {
      tabs = results[0].value;
    } else {
      console.error("Failed to get tabs:", results[0].reason);
      // getOpenTabs shows its own toast on failure, except for "not running"
    }
    if (results[1].status === "fulfilled") {
      history = results[1].value;
    } else {
      console.error("Failed to get history:", results[1].reason);
      // getHistory shows its own toasts on failure (e.g., permissions)
    }
  } else {
    console.log(`Brave is not running. Fetching history only (last ${historyDays} days)...`);
    showToast({
      style: Toast.Style.Info,
      title: "Brave Browser Not Running",
      message: "Showing history only. Start Brave to see open tabs.",
    });
    // Fetch history directly
    try {
      history = await getHistory(historyDays);
    } catch (err) {
      console.error("Failed to get history when Brave not running:", err);
      // getHistory should handle showing toasts for specific errors
    }
    // tabs remains []
  }

  console.log(`Fetched ${tabs.length} tabs, ${history.length} history entries.`);
  return { tabs, history, isRunning };
}

// --- Component Props ---
interface CommonItemProps {
  revalidate: () => void; // Function to reload data
}

interface TabListItemProps extends CommonItemProps {
  tab: Tab;
}

interface HistoryListItemProps extends CommonItemProps {
  entry: HistoryEntry;
}

interface ActionListItemProps extends CommonItemProps {
  title: string;
  icon: Icon;
  primaryAction: () => void;
  primaryActionTitle: string;
  secondaryAction?: () => void;
  secondaryActionTitle?: string;
  textToCopy: string;
}

// --- Reusable Action Component ---
function ReloadDataAction({ onReload }: { onReload: () => void }) {
  return (
    <Action
      title="Reload Data"
      icon={Icon.ArrowClockwise}
      onAction={onReload}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
    />
  );
}

// --- List Item Components ---

function TabListItem({ tab, revalidate }: TabListItemProps) {
  return (
    <List.Item
      key={tab.id}
      title={tab.title || "Untitled Tab"}
      subtitle={tab.url}
      icon={Icon.Globe}
      keywords={[tab.url]}
      actions={
        <ActionPanel>
          <Action title="Switch to Tab" icon={Icon.Eye} onAction={() => switchToTab(tab.windowId, tab.tabIndex)} />
          <Action.OpenInBrowser url={tab.url} />
          <Action.CopyToClipboard title="Copy URL" content={tab.url} />
          <ReloadDataAction onReload={revalidate} />
        </ActionPanel>
      }
    />
  );
}

function HistoryListItem({ entry, revalidate }: HistoryListItemProps) {
  return (
    <List.Item
      key={entry.id}
      title={entry.title || "Untitled Page"}
      subtitle={entry.url}
      icon={Icon.Clock}
      keywords={[entry.url]}
      accessories={[
        {
          date: new Date(entry.lastVisited),
          tooltip: `Last Visited: ${new Date(entry.lastVisited).toLocaleString()}`,
        },
      ]}
      actions={
        <ActionPanel>
          <Action title="Open in New Tab" icon={Icon.Plus} onAction={() => openUrlInNewTab(entry.url)} />
          <Action.OpenInBrowser url={entry.url} />
          <Action.CopyToClipboard title="Copy URL" content={entry.url} />
          <ReloadDataAction onReload={revalidate} />
        </ActionPanel>
      }
    />
  );
}

// Component for "Open URL" or "Search" actions based on input text
function ActionListItem({
  title,
  icon,
  primaryAction,
  primaryActionTitle,
  secondaryAction,
  secondaryActionTitle,
  textToCopy,
  revalidate,
}: ActionListItemProps) {
  return (
    <List.Item
      key={primaryActionTitle.toLowerCase().replace(" ", "-")} // e.g., "open-url" or "search-with-brave"
      title={title}
      icon={icon}
      actions={
        <ActionPanel>
          <Action title={primaryActionTitle} icon={icon} onAction={primaryAction} />
          {secondaryAction && secondaryActionTitle && (
            // Determine icon based on secondary action title
            <Action
              title={secondaryActionTitle}
              icon={secondaryActionTitle.startsWith("Search") ? Icon.MagnifyingGlass : Icon.Link}
              onAction={secondaryAction}
            />
          )}
          <Action.CopyToClipboard title="Copy Input Text" content={textToCopy} />
          <ReloadDataAction onReload={revalidate} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const [searchText, setSearchText] = React.useState<string>("");

  const {
    data,
    isLoading: isLoadingData,
    revalidate,
    error, // Capture error for more specific handling if needed
  } = usePromise(
    fetchBraveData,
    [], // Dependencies array - empty means run once on mount
    {
      onError: (err) => {
        console.error("Error loading data:", err);
        // Avoid showing generic toast if specific errors (like permissions) were already shown by fetchBraveData/getHistory
        if (!(err instanceof Error && err.message.includes("Full Disk Access"))) {
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to load Brave data",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      },
      // Keep previous data while revalidating (e.g., on manual refresh)
      keepPreviousData: true,
    }
  );

  // Destructure data with defaults
  const { tabs: rawTabs, history: rawHistory, isRunning } = data ?? { tabs: [], history: [], isRunning: false };

  // --- Filtering logic using Fuse.js (remains the same) ---
  const fuseOptionsTab: Fuse.IFuseOptions<Tab> = {
    keys: ["title", "url"],
    includeScore: false,
    threshold: 0.3,
    minMatchCharLength: 3,
    ignoreLocation: true,
  };
  const fuseOptionsHistory: Fuse.IFuseOptions<HistoryEntry> = {
    keys: ["title", "url"],
    includeScore: false,
    threshold: 0.3,
    minMatchCharLength: 3,
    ignoreLocation: true,
  };

  const filteredTabs = React.useMemo(() => {
    if (!searchText || rawTabs.length === 0) return rawTabs;
    const fuse = new Fuse(rawTabs, fuseOptionsTab);
    return fuse.search(searchText).map((result) => result.item);
  }, [rawTabs, searchText]);

  const filteredHistory = React.useMemo(() => {
    if (!searchText || rawHistory.length === 0) return rawHistory;
    const fuse = new Fuse(rawHistory, fuseOptionsHistory);
    return fuse.search(searchText).map((result) => result.item);
  }, [rawHistory, searchText]);

  // isLoading is true during initial fetch or if data is explicitly cleared during revalidation
  const isLoading = isLoadingData && !data; // Show loading only on initial load or if data is cleared

  // Determine if any results are available after filtering
  const hasResults = filteredTabs.length > 0 || filteredHistory.length > 0;
  const trimmedSearchText = searchText.trim();
  const looksLikeUrl = isValidUrl(trimmedSearchText);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={
        isRunning ? "Search tabs, history, URL, or query..." : "Search history, URL, or query (Start Brave for tabs)..."
      }
      onSearchTextChange={setSearchText}
      throttle // Keep throttle for UI responsiveness
    >
      {/* Empty View Logic */}
      {!isLoading && !hasResults && !trimmedSearchText && (
        <List.EmptyView
          title={!isRunning ? "Brave Not Running" : "No Tabs or Recent History"}
          description={
            !isRunning
              ? "Start Brave to search open tabs. History requires Full Disk Access."
              : "Could not find open tabs or recent history. Check Full Disk Access permissions if history is expected."
          }
          actions={
            <ActionPanel>
              <ReloadDataAction onReload={revalidate} />
            </ActionPanel>
          }
        />
      )}
      {!isLoading && !hasResults && trimmedSearchText && (
        <List.EmptyView
          title="No Matches Found"
          description="Try a different search term."
          actions={
            <ActionPanel>
              {/* Show search action even if no results */}
              <Action
                title={`Search with Brave: ${trimmedSearchText}`}
                icon={Icon.MagnifyingGlass}
                onAction={() => searchWithBrave(trimmedSearchText)}
              />
              <ReloadDataAction onReload={revalidate} />
            </ActionPanel>
          }
        />
      )}

      {/* Open Tabs Section */}
      {isRunning && filteredTabs.length > 0 && (
        <List.Section title="Open Tabs" subtitle={filteredTabs.length.toString()}>
          {filteredTabs.map((tab) => (
            <TabListItem key={tab.id} tab={tab} revalidate={revalidate} />
          ))}
        </List.Section>
      )}

      {/* History Section */}
      {filteredHistory.length > 0 && (
        <List.Section title="Browsing History" subtitle={filteredHistory.length.toString()}>
          {filteredHistory.map((entry) => (
            <HistoryListItem key={entry.id} entry={entry} revalidate={revalidate} />
          ))}
        </List.Section>
      )}

      {/* Actions Section - Render based on current search text */}
      {trimmedSearchText && (
        <List.Section title="Actions">
          {looksLikeUrl && (
            <ActionListItem
              title={`Open URL: ${trimmedSearchText}`}
              icon={Icon.Link}
              primaryAction={() => openUrlInNewTab(trimmedSearchText)}
              primaryActionTitle="Open URL in New Tab"
              secondaryAction={() => searchWithBrave(trimmedSearchText)} // Offer search as secondary
              secondaryActionTitle="Search with Brave"
              textToCopy={trimmedSearchText}
              revalidate={revalidate}
            />
          )}
          <ActionListItem
            title={`Search with Brave: ${trimmedSearchText}`}
            icon={Icon.MagnifyingGlass}
            primaryAction={() => searchWithBrave(trimmedSearchText)}
            primaryActionTitle="Search with Brave"
            // Only add secondary "Open URL" if it wasn't the primary action above
            secondaryAction={looksLikeUrl ? () => openUrlInNewTab(trimmedSearchText) : undefined}
            secondaryActionTitle={looksLikeUrl ? "Open URL in New Tab" : undefined}
            textToCopy={trimmedSearchText}
            revalidate={revalidate}
          />
        </List.Section>
      )}
    </List>
  );
}
