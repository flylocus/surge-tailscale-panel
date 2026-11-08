// ============================================================
// Surge Panel Script: Tailscale Mesh Topology Monitor & Ghost Node Cleaner
// Version: 1.3.0 (Community Edition)
// Runtime Compatibility: Surge iOS & Surge macOS (Native ES5 / JavaScriptCore)
// License: MIT
// ============================================================

var MAX_DELETE_PER_RUN = 10;
var DEFAULT_MIN_OFFLINE_HOURS = 24;

function safeRun(fn) {
  try {
    fn();
  } catch (e) {
    $done({
      title: "Tailscale Script Error",
      content: "Runtime exception: " + String(e && e.message ? e.message : e),
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF9500"
    });
  }
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

function safeEncode(str) {
  try {
    return encodeURIComponent(String(str));
  } catch (_) {
    return String(str).replace(/[^a-zA-Z0-9._~-]/g, "");
  }
}

function logAudit(msg) {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log("[Tailscale-Mesh] " + msg);
  }
}

function parseArgs(raw) {
  var result = Object.create(null);
  if (!raw || typeof raw !== "string") return result;
  var pairs = raw.split("&");
  for (var i = 0; i < pairs.length; i++) {
    var part = pairs[i];
    if (!part) continue;
    var idx = part.indexOf("=");
    if (idx === -1) {
      result[safeDecode(part).trim()] = "";
    } else {
      var k = safeDecode(part.slice(0, idx)).trim();
      var v = safeDecode(part.slice(idx + 1)).trim();
      result[k] = v;
    }
  }
  return result;
}

function parseBoolStrict(val, defaultVal) {
  if (val === undefined || val === null || val === "") return defaultVal;
  var s = String(val).trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return defaultVal;
}

function clampVisibleCount(val) {
  var n = parseInt(val, 10);
  if (isNaN(n)) return 5;
  if (n < 1) return 1;
  if (n > 5) return 5;
  return n;
}

function clampMinOfflineHours(val) {
  var n = parseInt(val, 10);
  if (isNaN(n)) return DEFAULT_MIN_OFFLINE_HOURS;
  if (n < 1) return 1;
  if (n > 720) return 720;
  return n;
}

function formatRelativeTime(isoStr, nowMs) {
  if (!isoStr) return "unknown";
  var seenMs = Date.parse(isoStr);
  if (isNaN(seenMs)) return String(isoStr);
  if (seenMs <= 0) return "never";
  var diffSec = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  if (diffSec < 60) return diffSec + "s ago";
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + "m ago";
  var diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return diffHour + "h ago";
  var diffDay = Math.floor(diffHour / 24);
  return diffDay + "d ago";
}

function hasExplicitOnlineState(d) {
  return Boolean(
    d &&
      (typeof d.connectedToControl === "boolean" ||
        typeof d.online === "boolean")
  );
}

// Evaluate online state strictly from explicit control-plane boolean fields
// (connectedToControl / online); never infer online status from lastSeen timestamps.
function isDeviceOnline(d) {
  if (!d) return false;
  if (typeof d.connectedToControl === "boolean") return d.connectedToControl;
  if (typeof d.online === "boolean") return d.online;
  return false;
}

function getShortName(d) {
  if (d && d.name) {
    return String(d.name).split(".")[0];
  }
  return (d && (d.hostname || d.id)) || "unknown-node";
}

function stripNumericSuffix(name) {
  return String(name || "").toLowerCase().replace(/-\d+$/, "");
}

function hasNumericSuffix(name) {
  return /-\d+$/.test(String(name || "").toLowerCase());
}

// Protected nodes (ACL-tagged servers, external shared devices, or nodes with
// key expiry explicitly disabled) are never eligible for automated cloud deletion.
function isProtectedDevice(d) {
  if (!d) return true;
  if (d.isExternal === true) return true;
  if (d.keyExpiryDisabled === true) return true;
  if (Array.isArray(d.tags) && d.tags.length > 0) return true;
  return false;
}

// 4-tuple composite grouping key (base | hostname | os | user) guarded by 5 mandatory
// identity attributes (id, name, hostname, os, user) and an explicit boolean online state.
// Matches Tailscale's auto-incrementing suffix pattern (base === hostname, identical os & user,
// and at least one -N suffixed sibling in the same group).
function computeGhostGroupKey(d, baseStats, fallbackIndex) {
  if (
    !d ||
    !d.id ||
    !d.name ||
    !d.hostname ||
    !d.os ||
    !d.user ||
    !hasExplicitOnlineState(d)
  ) {
    return "unique:" + (d && d.id ? String(d.id) : "idx-" + String(fallbackIndex));
  }
  var shortLower = getShortName(d).toLowerCase();
  var base = stripNumericSuffix(shortLower);
  var hostLower = String(d.hostname).toLowerCase();
  var osLower = String(d.os).toLowerCase();
  var userLower = String(d.user).toLowerCase();
  var compositeKey = base + "|" + hostLower + "|" + osLower + "|" + userLower;
  var stat = baseStats[compositeKey];

  if (!stat || stat.count <= 1 || !stat.hasSuffixedMember || hostLower !== base) {
    return "unique:" + String(d.id);
  }

  return "ghost:" + compositeKey;
}

function finishPanel(onlineList, offlineList, unknownList, maxVisible, statusSuffix, extraFooter) {
  var allLines = onlineList.concat(offlineList).concat(unknownList);
  var onlineCount = onlineList.length;
  var totalCount = allLines.length;

  var visibleLines = allLines.slice(0, maxVisible);
  var hiddenCount = totalCount - visibleLines.length;
  if (hiddenCount > 0) {
    visibleLines.push("… " + hiddenCount + " more nodes folded");
  }
  if (extraFooter) {
    visibleLines.push(extraFooter);
  }

  var iconColor = "#34C759";
  if (onlineCount === 0) {
    iconColor = "#FF3B30";
  } else if (onlineCount < totalCount) {
    iconColor = "#007AFF";
  }

  var unknownTag = unknownList.length > 0 ? " · " + unknownList.length + " unknown" : "";

  $done({
    title:
      "Tailscale Mesh (" +
      onlineCount +
      "/" +
      totalCount +
      " Online" +
      unknownTag +
      (statusSuffix || "") +
      ")",
    content: visibleLines.join("\n"),
    icon: "network",
    "icon-color": iconColor
  });
}

safeRun(function main() {
  var rawArg = typeof $argument !== "undefined" ? String($argument) : "";
  var params = parseArgs(rawArg);
  var tailnet = params.tailnet || "-";
  var apiKey = params.apikey || "";
  var hideDup = parseBoolStrict(params.hide_dup, true);
  // Cloud device garbage collection is disabled by default; requires explicit "true" or "1".
  var cleanDup = parseBoolStrict(params.clean_dup, false);
  var dryRun = parseBoolStrict(params.dry_run, false);
  var maxVisible = clampVisibleCount(params.max_visible);
  var minOfflineHours = clampMinOfflineHours(params.min_offline_hours);
  var minOfflineMs = minOfflineHours * 3600 * 1000;

  if (
    !apiKey ||
    apiKey === "tskey-api-xxx" ||
    apiKey === "YOUR_TSKEY_API_TOKEN" ||
    apiKey.indexOf("{{{") !== -1 ||
    tailnet.indexOf("{{{") !== -1
  ) {
    $done({
      title: "Tailscale Mesh Monitor",
      content: "Please configure a valid API_KEY in module arguments",
      icon: "network.badge.shield.half.filled",
      "icon-color": "#FF3B30"
    });
    return;
  }

  var url =
    "https://api.tailscale.com/api/v2/tailnet/" +
    safeEncode(tailnet) +
    "/devices?fields=all";

  $httpClient.get(
    {
      url: url,
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json"
      },
      timeout: 6
    },
    function (error, response, data) {
      safeRun(function () {
        var status = response ? response.status || response.statusCode : 0;
        if (error || status !== 200) {
          var errMsg = error ? String(error) : "HTTP Status: " + status;
          if (status === 401 || status === 403) {
            errMsg = "Invalid API Key or insufficient permissions (HTTP " + status + ")";
          }
          $done({
            title: "Tailscale API Error",
            content: errMsg,
            icon: "exclamationmark.triangle.fill",
            "icon-color": "#FF9500"
          });
          return;
        }

        var parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          $done({
            title: "Tailscale Parse Error",
            content: "JSON parse failed: " + String(e),
            icon: "exclamationmark.triangle.fill",
            "icon-color": "#FF9500"
          });
          return;
        }

        var devices = parsed && Array.isArray(parsed.devices) ? parsed.devices : [];
        if (devices.length === 0) {
          $done({
            title: "Tailscale Mesh (0)",
            content: "No devices found in the current Tailnet",
            icon: "network",
            "icon-color": "#8E8E93"
          });
          return;
        }

        var nowMs = Date.now();
        var baseStats = Object.create(null);

        for (var i = 0; i < devices.length; i++) {
          var d0 = devices[i] || {};
          if (
            !d0.id ||
            !d0.name ||
            !d0.hostname ||
            !d0.os ||
            !d0.user ||
            !hasExplicitOnlineState(d0)
          ) {
            continue;
          }
          var sLower = getShortName(d0).toLowerCase();
          var base = stripNumericSuffix(sLower);
          var hostLower = String(d0.hostname).toLowerCase();
          var osLower = String(d0.os).toLowerCase();
          var userLower = String(d0.user).toLowerCase();
          if (!base || hostLower !== base) continue;

          var cKey = base + "|" + hostLower + "|" + osLower + "|" + userLower;
          if (!baseStats[cKey]) {
            baseStats[cKey] = {
              count: 0,
              hasExactBaseMember: false,
              hasSuffixedMember: false
            };
          }
          baseStats[cKey].count += 1;
          if (sLower === base) {
            baseStats[cKey].hasExactBaseMember = true;
          }
          if (hasNumericSuffix(sLower)) {
            baseStats[cKey].hasSuffixedMember = true;
          }
        }

        var groupCounts = Object.create(null);
        var groupHasOnline = Object.create(null);
        var groupLatestOffline = Object.create(null);

        for (var j = 0; j < devices.length; j++) {
          var dev = devices[j] || {};
          var key = computeGhostGroupKey(dev, baseStats, j);
          groupCounts[key] = (groupCounts[key] || 0) + 1;
          if (!hasExplicitOnlineState(dev)) continue;
          var online = isDeviceOnline(dev);
          if (online) {
            groupHasOnline[key] = true;
          } else if (dev.lastSeen) {
            var seenMs = Date.parse(dev.lastSeen);
            if (!isNaN(seenMs) && seenMs > 0 && dev.id) {
              if (!groupLatestOffline[key] || seenMs > groupLatestOffline[key].seenMs) {
                groupLatestOffline[key] = { id: String(dev.id), seenMs: seenMs };
              }
            }
          }
        }

        var onlineList = [];
        var offlineList = [];
        var unknownList = [];
        var duplicateCandidates = [];
        var hiddenDupNames = [];
        var hiddenDupCount = 0;

        for (var k = 0; k < devices.length; k++) {
          var d = devices[k] || {};
          var gKey = computeGhostGroupKey(d, baseStats, k);
          var displayName = getShortName(d);
          var ipv4 = Array.isArray(d.addresses) && d.addresses.length > 0 ? d.addresses[0] : "-";

          if (!hasExplicitOnlineState(d)) {
            unknownList.push("⚪ " + displayName + " (" + ipv4 + " · state unknown)");
            continue;
          }

          var isOnline = isDeviceOnline(d);
          if (isOnline) {
            onlineList.push("🟢 " + displayName + " (" + ipv4 + ")");
          } else {
            var dSeenMs = d.lastSeen ? Date.parse(d.lastSeen) : NaN;
            var hasValidSeen = !isNaN(dSeenMs) && dSeenMs > 0;
            var offlineAgeMs = hasValidSeen ? Math.max(0, nowMs - dSeenMs) : 0;
            var isGhostGroup = gKey.indexOf("ghost:") === 0 && groupCounts[gKey] > 1;

            // Classify an offline node as a duplicate ghost when it has an explicit
            // offline boolean state, a valid lastSeen timestamp, and its group contains
            // either an active online node or a strictly newer offline sibling.
            var isDupOffline =
              isGhostGroup &&
              hasExplicitOnlineState(d) &&
              hasValidSeen &&
              (groupHasOnline[gKey] === true ||
                (groupLatestOffline[gKey] &&
                  groupLatestOffline[gKey].id !== String(d.id) &&
                  dSeenMs < groupLatestOffline[gKey].seenMs));

            // Cloud deletion eligibility requires:
            // 1. Offline duration >= minOfflineMs (default 24h) to avoid deleting rebooting siblings;
            // 2. Device is not ACL-tagged, external, or marked keyExpiryDisabled.
            var eligibleForClean =
              isDupOffline &&
              Boolean(d.id) &&
              offlineAgeMs >= minOfflineMs &&
              !isProtectedDevice(d);

            if (isDupOffline && (hideDup || cleanDup || dryRun)) {
              hiddenDupCount += 1;
              hiddenDupNames.push(displayName + "[" + String(d.id) + "]");
              if (eligibleForClean && duplicateCandidates.length < MAX_DELETE_PER_RUN) {
                duplicateCandidates.push({
                  id: String(d.id),
                  name: displayName,
                  ageHours: Math.floor(offlineAgeMs / 3600000)
                });
              }
              continue;
            }

            var seenText = formatRelativeTime(d.lastSeen, nowMs);
            offlineList.push("🔴 " + displayName + " (" + ipv4 + " · " + seenText + ")");
          }
        }

        if (hiddenDupNames.length > 0) {
          logAudit(
            "Detected " +
              hiddenDupNames.length +
              " duplicate offline ghost node(s): " +
              hiddenDupNames.join(", ")
          );
        }

        if (dryRun) {
          var dryLabels = [];
          var previewLimit = Math.min(duplicateCandidates.length, 3);
          for (var dIdx = 0; dIdx < previewLimit; dIdx++) {
            var cand = duplicateCandidates[dIdx];
            dryLabels.push(cand.name + " (" + cand.ageHours + "h)");
          }
          if (duplicateCandidates.length > 3) {
            dryLabels.push("+" + (duplicateCandidates.length - 3) + " more");
          }
          var dryFooter =
            dryLabels.length > 0
              ? "🔍 Dry-run cleanable (>=" + minOfflineHours + "h): " + dryLabels.join(", ")
              : "🔍 Dry-run: 0 nodes meet >=" + minOfflineHours + "h clean threshold";
          var drySuffix =
            " · " + duplicateCandidates.length + " cleanable (dry-run)";
          finishPanel(onlineList, offlineList, unknownList, maxVisible, drySuffix, dryFooter);
          return;
        }

        if (!cleanDup || duplicateCandidates.length === 0) {
          var suffix = hiddenDupCount > 0 ? " · " + hiddenDupCount + " dup hidden" : "";
          finishPanel(onlineList, offlineList, unknownList, maxVisible, suffix, "");
          return;
        }

        if (typeof $httpClient.delete !== "function") {
          logAudit("$httpClient.delete is unavailable in this runtime; falling back to hide-only.");
          finishPanel(
            onlineList,
            offlineList,
            unknownList,
            maxVisible,
            " · delete unsupported (hidden)"
          );
          return;
        }

        var pending = duplicateCandidates.length;
        var okCount = 0;
        var failCount = 0;
        var forbiddenCount = 0;

        for (var m = 0; m < duplicateCandidates.length; m++) {
          (function (candidate) {
            $httpClient.delete(
              {
                url: "https://api.tailscale.com/api/v2/device/" + safeEncode(candidate.id),
                headers: {
                  Authorization: "Bearer " + apiKey
                },
                timeout: 6
              },
              function (delErr, delResp) {
                safeRun(function () {
                  var delStatus = delResp ? delResp.status || delResp.statusCode : 0;
                  // HTTP 2xx or 404 (already deleted) counts as successful cleanup
                  if (!delErr && ((delStatus >= 200 && delStatus < 300) || delStatus === 404)) {
                    okCount += 1;
                    logAudit("Deleted ghost node: " + candidate.name + " (" + candidate.id + ")");
                  } else {
                    failCount += 1;
                    if (delStatus === 403 || delStatus === 401) {
                      forbiddenCount += 1;
                    }
                    logAudit(
                      "Failed to delete ghost node: " +
                        candidate.name +
                        " (" +
                        candidate.id +
                        ") HTTP " +
                        delStatus
                    );
                  }
                  pending -= 1;
                  if (pending <= 0) {
                    var delSuffix = "";
                    if (okCount > 0 && failCount === 0) {
                      delSuffix = " · " + okCount + " dup cleaned";
                    } else if (okCount > 0 && failCount > 0) {
                      delSuffix = " · " + okCount + " cleaned/" + failCount + " failed";
                    } else if (forbiddenCount > 0) {
                      delSuffix = " · clean 403 forbidden (hidden)";
                    } else {
                      delSuffix = " · " + failCount + " clean failed (hidden)";
                    }
                    finishPanel(onlineList, offlineList, unknownList, maxVisible, delSuffix);
                  }
                });
              }
            );
          })(duplicateCandidates[m]);
        }
      });
    }
  );
});
