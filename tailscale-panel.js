// ============================================================
// Surge Panel Script: Tailscale Device Status & Ghost Node Cleaner
// Compatible with: Surge iOS / Surge Mac (JavaScriptCore)
// ============================================================

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
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

function formatRelativeTime(isoStr, nowMs) {
  if (!isoStr) return "未知";
  var seenMs = Date.parse(isoStr);
  if (isNaN(seenMs)) return String(isoStr);
  var diffSec = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  if (diffSec < 60) return diffSec + "秒前";
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + "分钟前";
  var diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return diffHour + "小时前";
  var diffDay = Math.floor(diffHour / 24);
  return diffDay + "天前";
}

function hasExplicitOnlineState(d) {
  return Boolean(
    d &&
      (typeof d.connectedToControl === "boolean" ||
        typeof d.online === "boolean")
  );
}

// 仅依据 API 明确返回的布尔连接状态（connectedToControl / online）判定在线，不根据 lastSeen 推断在线
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
  return (d && (d.hostname || d.id)) || "未知设备";
}

function stripNumericSuffix(name) {
  return String(name || "").toLowerCase().replace(/-\d+$/, "");
}

function hasNumericSuffix(name) {
  return /-\d+$/.test(String(name || "").toLowerCase());
}

// 严格幽灵节点分组：必须同时具备完整身份字段（id, name, hostname, os, user）与明确在线状态字段，
// 且满足 Tailscale 同名递增特征（base 相同、hostname===base、同属同一 user 与 os、且组内存在 -数字 后缀节点）
function computeGhostGroupKey(d, baseStats) {
  if (
    !d ||
    !d.id ||
    !d.name ||
    !d.hostname ||
    !d.os ||
    !d.user ||
    !hasExplicitOnlineState(d)
  ) {
    return "unique:" + (d && d.id ? String(d.id) : Math.random());
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

function finishPanel(onlineList, offlineList, maxVisible, statusSuffix) {
  var allLines = onlineList.concat(offlineList);
  var onlineCount = onlineList.length;
  var totalCount = allLines.length;

  var visibleLines = allLines.slice(0, maxVisible);
  var hiddenCount = totalCount - visibleLines.length;
  if (hiddenCount > 0) {
    visibleLines.push("… 其余 " + hiddenCount + " 个节点已折叠");
  }

  var iconColor = "#34C759";
  if (onlineCount === 0) {
    iconColor = "#FF3B30";
  } else if (onlineCount < totalCount) {
    iconColor = "#007AFF";
  }

  $done({
    title: "Tailscale 节点 (" + onlineCount + "/" + totalCount + " 在线" + (statusSuffix || "") + ")",
    content: visibleLines.join("\n"),
    icon: "network",
    "icon-color": iconColor
  });
}

(function main() {
  var rawArg = typeof $argument !== "undefined" ? String($argument) : "";
  var params = parseArgs(rawArg);
  var tailnet = params.tailnet || "-";
  var apiKey = params.apikey || "";
  var hideDup = parseBoolStrict(params.hide_dup, true);
  // 云端删除默认关闭，且采用严格白名单（仅 true 或 1 开启）
  var cleanDup = parseBoolStrict(params.clean_dup, false);
  var maxVisible = clampVisibleCount(params.max_visible);

  if (
    !apiKey ||
    apiKey === "tskey-api-xxx" ||
    apiKey === "{{{API_KEY}}}" ||
    tailnet === "{{{TAILNET}}}"
  ) {
    $done({
      title: "Tailscale 节点监控",
      content: "请在模块参数中设置有效的 API_KEY",
      icon: "network.badge.shield.half.filled",
      "icon-color": "#FF3B30"
    });
    return;
  }

  var url =
    "https://api.tailscale.com/api/v2/tailnet/" +
    encodeURIComponent(tailnet) +
    "/devices?fields=all";

  $httpClient.get(
    {
      url: url,
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json"
      },
      timeout: 10
    },
    function (error, response, data) {
      var status = response ? response.status || response.statusCode : 0;
      if (error || status !== 200) {
        var errMsg = error ? String(error) : "HTTP 状态码: " + status;
        if (status === 401 || status === 403) {
          errMsg = "API Key 无效或权限不足 (HTTP " + status + ")";
        }
        $done({
          title: "Tailscale 状态异常",
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
          title: "Tailscale 解析失败",
          content: "JSON 解析错误: " + String(e),
          icon: "exclamationmark.triangle.fill",
          "icon-color": "#FF9500"
        });
        return;
      }

      var devices = parsed && Array.isArray(parsed.devices) ? parsed.devices : [];
      if (devices.length === 0) {
        $done({
          title: "Tailscale 节点 (0)",
          content: "当前 Tailnet 下未找到任何设备",
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
        var key = computeGhostGroupKey(dev, baseStats);
        groupCounts[key] = (groupCounts[key] || 0) + 1;
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
      var duplicateOfflineIds = [];
      var hiddenDupCount = 0;

      for (var k = 0; k < devices.length; k++) {
        var d = devices[k] || {};
        var gKey = computeGhostGroupKey(d, baseStats);
        var isOnline = isDeviceOnline(d);
        var displayName = getShortName(d);
        var ipv4 = Array.isArray(d.addresses) && d.addresses.length > 0 ? d.addresses[0] : "-";

        if (isOnline) {
          onlineList.push("🟢 " + displayName + " (" + ipv4 + ")");
        } else {
          var dSeenMs = d.lastSeen ? Date.parse(d.lastSeen) : NaN;
          var hasValidSeen = !isNaN(dSeenMs) && dSeenMs > 0;
          var isGhostGroup = gKey.indexOf("ghost:") === 0 && groupCounts[gKey] > 1;

          // 仅当离线节点自身具备明确离线状态与有效 lastSeen，且同组存在明确在线节点或更新的离线节点时，才视为旧幽灵节点
          var isDupOffline =
            isGhostGroup &&
            hasExplicitOnlineState(d) &&
            hasValidSeen &&
            (groupHasOnline[gKey] === true ||
              (groupLatestOffline[gKey] &&
                groupLatestOffline[gKey].id !== String(d.id) &&
                dSeenMs < groupLatestOffline[gKey].seenMs));

          if (isDupOffline && (hideDup || cleanDup)) {
            hiddenDupCount += 1;
            if (cleanDup && d.id) {
              duplicateOfflineIds.push(String(d.id));
            }
            continue;
          }

          var seenText = formatRelativeTime(d.lastSeen, nowMs);
          offlineList.push("🔴 " + displayName + " (" + ipv4 + " · " + seenText + ")");
        }
      }

      if (!cleanDup || duplicateOfflineIds.length === 0 || typeof $httpClient.delete !== "function") {
        var suffix = hiddenDupCount > 0 ? " · 已隐藏" + hiddenDupCount + "个重复" : "";
        finishPanel(onlineList, offlineList, maxVisible, suffix);
        return;
      }

      var pending = duplicateOfflineIds.length;
      var okCount = 0;
      var failCount = 0;
      var finished = false;

      for (var m = 0; m < duplicateOfflineIds.length; m++) {
        (function (delId) {
          $httpClient.delete(
            {
              url: "https://api.tailscale.com/api/v2/device/" + encodeURIComponent(delId),
              headers: {
                Authorization: "Bearer " + apiKey
              },
              timeout: 8
            },
            function (delErr, delResp) {
              if (finished) return;
              var delStatus = delResp ? delResp.status || delResp.statusCode : 0;
              if (!delErr && delStatus >= 200 && delStatus < 300) {
                okCount += 1;
              } else {
                failCount += 1;
              }
              pending -= 1;
              if (pending <= 0) {
                finished = true;
                var delSuffix = "";
                if (okCount > 0 && failCount === 0) {
                  delSuffix = " · 已清理" + okCount + "个重复";
                } else if (okCount > 0 && failCount > 0) {
                  delSuffix = " · 已清理" + okCount + "个/失败" + failCount + "个";
                } else {
                  delSuffix = " · 清理失败" + failCount + "个(已隐藏)";
                }
                finishPanel(onlineList, offlineList, maxVisible, delSuffix);
              }
            }
          );
        })(duplicateOfflineIds[m]);
      }
    }
  );
})();
