# Brave Search Tabs and History - Raycast Extension

Bring an Arc browser-like command bar experience to Brave! This extension lets you instantly search through your open Brave tabs and recent browsing history, open URLs, or perform web searches directly from Raycast.

## Features

*   **Unified Search:** Access open tabs, history, and web actions from one place, similar to Arc's command bar.
*   **Search Open Tabs:** Fuzzy search through the titles and URLs of all tabs currently open in Brave. Select a tab to switch directly to it.
*   **Search History:** Fuzzy search through the titles and URLs of your browsing history from the last 7 days. Select an entry to open it in a new Brave tab.
*   **Open URL:** Type or paste a URL and select the "Open URL" action to open it in a new Brave tab.
*   **Web Search:** Type any query and select the "Search with Brave" action to perform a web search using your default search engine in a new Brave tab.

## Setup

1.  **Install the Extension:** Install "Brave Search Tabs and History" from the Raycast Store.
2.  **Grant Permissions (Required for History Search):**
    *   The first time you run the command, if it needs to access your browsing history, it might fail or show an error message due to permissions.
    *   Raycast needs **Full Disk Access** to read the Brave history database file (`~/Library/Application Support/BraveSoftware/Brave-Browser/.../History`).
    *   Go to macOS **System Settings** > **Privacy & Security** > **Full Disk Access**.
    *   Click the `+` button, find **Raycast** in the `/Applications` folder, and add it.
    *   Make sure the toggle next to Raycast is **enabled**.
    *   You might need to restart Raycast after granting permission.

## Usage

1.  Open Raycast (`⌥ + Space` by default).
2.  Type the command name, e.g., `Search Brave`, `Brave Tabs`, or `Search Tabs and History`.
3.  Start typing:
    *   Matching open tabs and history entries will appear.
    *   If you type a URL, an action to open it will be available.
    *   An action to search the web with your query will always be available.
4.  Use the arrow keys to navigate the results and `Enter` to perform the primary action (Switch to Tab, Open History Link, Open URL, or Search).
5.  Use `⌘ + K` to see other available actions for the selected item (e.g., Copy URL).

*Note:* The extension requires Brave Browser to be running to fetch open tabs or perform actions. History search reads the database file directly and does not require Brave to be running, but *does* require the Full Disk Access permission.*
