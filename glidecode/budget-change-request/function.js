// ═══════════════════════════════════════════════════════════════════════════════
// Budget Change Request Engine — Experimental Code Column for Glide
// ═══════════════════════════════════════════════════════════════════════════════
//
// A multi-function code column that implements the Budget Change Request (BCR)
// approval workflow for the Treasury App.
//
// USAGE:
//   function_name (string) — which function to call
//   payload       (string) — JSON object with function-specific inputs
//   config        (string) — JSON object (reserved for future use)
//
// RETURNS:
//   JSON string with the result (parse downstream in Glide)
//
// ─── APPROVAL CHAIN RULES ────────────────────────────────────────────────────
// Role-based only — no amount thresholds.
//
//   Requestor role  → Chain
//   ─────────────────────────────────────────────────
//   CEO             → Auto-approved
//   Entity Manager  → Project Manager → CEO
//   Project Manager → Entity Manager  → CEO
//   Responsible     → Project Manager → Entity Manager
//   Budget Owner    → Responsible → Project Manager → Entity Manager
//
// If the requestor holds multiple roles, the most privileged role determines
// the chain: CEO > EM > PM > Responsible > Owner.
//
// CEO override: CEO can always approve any pending step out of sequence.
//
// ─── AVAILABLE FUNCTIONS (3 consolidated) ────────────────────────────────────
//   A. getChangeRequestChain    — Determine role, build step array, summarize
//   B. getChangeRequestProgress — Status, next step, can-approve gate, edit/cancel
//   C. validateChangeRequest    — Pre-submit validation (naming, constraints)
//
// ═══════════════════════════════════════════════════════════════════════════════


// ─── ROLE CONSTANTS ───────────────────────────────────────────────────────────
var CEO_ROLE         = "tre.auth.ceo";
var ROLE_LABELS = {
  "responsible":     "Responsible",
  "project_manager": "Project Manager",
  "entity_manager":  "Entity Manager"
};
ROLE_LABELS[CEO_ROLE] = "CEO";


// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch (e) { return null; }
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim()) {
    try { var p = JSON.parse(val); if (Array.isArray(p)) return p; }
    catch (e) { /* not valid JSON */ }
  }
  return [];
}

function parseRoles(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
  }
  if (typeof input === "string") {
    var p = safeParse(input);
    if (Array.isArray(p)) {
      return p.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
    }
    return input.split(",").map(function(r) { return r.trim().toLowerCase(); }).filter(Boolean);
  }
  return [];
}

function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function normalize(str) {
  return (str || "").toLowerCase().trim();
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: Determine requestor's most privileged role
// ═══════════════════════════════════════════════════════════════════════════════
//
// Priority: CEO > entity_manager > project_manager > responsible > owner
//
// Returns one of: "ceo", "entity_manager", "project_manager", "responsible", "owner"
//
function getRequestorRole(requestorId, requestorRoles, ownerId, responsibleId, pmId, emId) {
  var roles = parseRoles(requestorRoles);
  if (roles.indexOf(CEO_ROLE) !== -1)           return "ceo";
  if (sameUser(requestorId, emId))              return "entity_manager";
  if (sameUser(requestorId, pmId))              return "project_manager";
  if (sameUser(requestorId, responsibleId))     return "responsible";
  // Default: budget owner (could be ownerId match or any other user with access)
  return "owner";
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: Build approval step array based on requestor role
// ═══════════════════════════════════════════════════════════════════════════════
//
// Returns { auto_approved, auto_approve_reason, steps, summary, short_summary }
//
function buildChain(requestorRole, responsibleId, responsibleName, pmId, pmName, emId, emName) {
  var steps = [];

  if (requestorRole === "ceo") {
    return {
      auto_approved: true,
      auto_approve_reason: "requestor_is_ceo",
      steps: [],
      summary: "Auto-approved",
      short_summary: "Auto-approved"
    };
  }

  if (requestorRole === "entity_manager") {
    // EM requests → PM → CEO
    if (pmId) {
      steps.push({ step: 1, role: "project_manager", user_id: pmId, user_name: pmName || "PM", status: "pending" });
    }
    steps.push({ step: steps.length + 1, role: CEO_ROLE, user_id: null, user_name: "CEO", status: "pending" });
  }

  else if (requestorRole === "project_manager") {
    // PM requests → EM → CEO
    if (emId) {
      steps.push({ step: 1, role: "entity_manager", user_id: emId, user_name: emName || "EM", status: "pending" });
    }
    steps.push({ step: steps.length + 1, role: CEO_ROLE, user_id: null, user_name: "CEO", status: "pending" });
  }

  else if (requestorRole === "responsible") {
    // Responsible requests → PM → EM
    if (pmId) {
      steps.push({ step: steps.length + 1, role: "project_manager", user_id: pmId, user_name: pmName || "PM", status: "pending" });
    }
    if (emId) {
      steps.push({ step: steps.length + 1, role: "entity_manager", user_id: emId, user_name: emName || "EM", status: "pending" });
    }
    if (steps.length === 0) {
      // No PM or EM assigned — requires CEO
      steps.push({ step: 1, role: CEO_ROLE, user_id: null, user_name: "CEO", status: "pending" });
    }
  }

  else {
    // owner (or anyone else) → Responsible → PM → EM
    if (responsibleId) {
      steps.push({ step: steps.length + 1, role: "responsible", user_id: responsibleId, user_name: responsibleName || "Responsible", status: "pending" });
    }
    if (pmId) {
      steps.push({ step: steps.length + 1, role: "project_manager", user_id: pmId, user_name: pmName || "PM", status: "pending" });
    }
    if (emId) {
      steps.push({ step: steps.length + 1, role: "entity_manager", user_id: emId, user_name: emName || "EM", status: "pending" });
    }
    if (steps.length === 0) {
      steps.push({ step: 1, role: CEO_ROLE, user_id: null, user_name: "CEO", status: "pending" });
    }
  }

  // Build display summaries
  var parts = steps.map(function(s) {
    var label = ROLE_LABELS[s.role] || s.role;
    return s.user_name ? label + " (" + s.user_name + ")" : label;
  });
  var summary = parts.join(" → ");
  var shortSummary = steps.length + "-step approval";

  return {
    auto_approved: false,
    auto_approve_reason: null,
    steps: steps,
    summary: summary,
    short_summary: shortSummary
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: Find the next pending step
// ═══════════════════════════════════════════════════════════════════════════════
function getNextStep(approvalSteps, completedSteps) {
  for (var i = 0; i < approvalSteps.length; i++) {
    if (completedSteps.indexOf(approvalSteps[i].step) === -1) {
      return approvalSteps[i];
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: Can the signed-in user approve this change request?
// ═══════════════════════════════════════════════════════════════════════════════
//
// Priority: contextual assignment (responsible/PM/EM) before CEO override.
// Requestor cannot approve their own request.
//
function canUserApproveInternal(data) {
  var approverId     = data.approver_id;
  var approverRoles  = parseRoles(data.approver_roles);
  var requestorId    = data.requestor_id;
  var requestStatus  = normalize(data.request_status || "");
  var approvalSteps  = ensureArray(data.approval_steps);
  var completedSteps = ensureArray(data.completed_steps);
  var responsibleId  = data.responsible_id;
  var pmId           = data.pm_id;
  var emId           = data.em_id;
  var isCeo          = approverRoles.indexOf(CEO_ROLE) !== -1;

  // Must be in review status
  if (requestStatus !== "review") {
    return { can_approve: false, reason: "request_not_in_review", step_number: null, role: null };
  }

  // Requestor cannot approve their own request (unless CEO — but CEO auto-approves, so this is defensive only)
  if (sameUser(approverId, requestorId) && !isCeo) {
    return { can_approve: false, reason: "cannot_approve_own_request", step_number: null, role: null };
  }

  // Determine which contextual roles this approver fulfills
  var contextualRoles = [];
  if (sameUser(approverId, responsibleId)) contextualRoles.push("responsible");
  if (sameUser(approverId, pmId))          contextualRoles.push("project_manager");
  if (sameUser(approverId, emId))          contextualRoles.push("entity_manager");

  // Check contextual role first — must match the next pending step in sequence
  for (var j = 0; j < approvalSteps.length; j++) {
    var step = approvalSteps[j];
    if (completedSteps.indexOf(step.step) !== -1) continue;
    if (contextualRoles.indexOf(step.role) !== -1) {
      return {
        can_approve: true,
        reason: "user_is_next_approver",
        step_number: step.step,
        role: step.role
      };
    }
    // Next pending step is not for this user's contextual role — stop checking
    break;
  }

  // CEO override — only reached if no contextual role matched
  if (isCeo) {
    var nextForCeo = getNextStep(approvalSteps, completedSteps);
    return {
      can_approve: true,
      reason: "ceo_override",
      step_number: nextForCeo ? nextForCeo.step : null,
      role: CEO_ROLE
    };
  }

  if (contextualRoles.length === 0) {
    return { can_approve: false, reason: "user_has_no_approval_role", step_number: null, role: null };
  }

  return { can_approve: false, reason: "not_current_approver", step_number: null, role: null };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION A: getChangeRequestChain
// ═══════════════════════════════════════════════════════════════════════════════
//
// Determines the approval chain based on the requestor's role.
//
// PAYLOAD:
// {
//   "requestor_id":       "SxPxchsmS.2tGPVdRPVHHg",
//   "requestor_roles":    "tre.auth.pm",                   // joined list of roles
//   "owner_id":           "abc123",
//   "responsible_id":     "def456",
//   "responsible_name":   "Chris Deluna",
//   "pm_id":              "IGDTvm71TuSnsezrMYyL5Q",
//   "pm_name":            "Diego Tobias",
//   "em_id":              "xyz789",
//   "em_name":            "Maria Lopez"
// }
//
// RETURNS:
// {
//   "auto_approved":       false,
//   "auto_approve_reason": null,
//   "requestor_role":      "project_manager",
//   "steps": [
//     { "step": 1, "role": "entity_manager", "user_id": "xyz789", "user_name": "Maria Lopez", "status": "pending" },
//     { "step": 2, "role": "tre.auth.ceo",   "user_id": null,     "user_name": "CEO",         "status": "pending" }
//   ],
//   "total_steps":   2,
//   "summary":       "Entity Manager (Maria Lopez) → CEO",
//   "short_summary": "2-step approval"
// }
//
function getChangeRequestChain(data) {
  var requestorId    = data.requestor_id;
  var requestorRoles = data.requestor_roles;
  var ownerId        = data.owner_id;
  var responsibleId  = data.responsible_id;
  var responsibleName = data.responsible_name || "";
  var pmId           = data.pm_id;
  var pmName         = data.pm_name || "";
  var emId           = data.em_id;
  var emName         = data.em_name || "";

  var requestorRole = getRequestorRole(requestorId, requestorRoles, ownerId, responsibleId, pmId, emId);
  var chain = buildChain(requestorRole, responsibleId, responsibleName, pmId, pmName, emId, emName);

  return {
    auto_approved:       chain.auto_approved,
    auto_approve_reason: chain.auto_approve_reason,
    requestor_role:      requestorRole,
    steps:               chain.steps,
    total_steps:         chain.steps.length,
    summary:             chain.summary,
    short_summary:       chain.short_summary
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION B: getChangeRequestProgress
// ═══════════════════════════════════════════════════════════════════════════════
//
// Tracks current approval progress and determines what the signed-in user can do.
//
// PAYLOAD:
// {
//   "approval_steps":   [...],               // from Controls/ApprovalSteps
//   "completed_steps":  [1],                 // from Controls/CompletedSteps
//   "rejected_step":    null,                // from Controls/RejectedStep
//   "auto_approved":    false,               // from BCR.Flags/Auto Approved
//   "approver_id":      "signed-in-row-id",
//   "approver_roles":   "tre.auth.em",
//   "requestor_id":     "requestor-row-id",  // to block self-approval
//   "request_status":   "review",
//   "responsible_id":   "def456",
//   "pm_id":            "IGDTvm71TuSnsezrMYyL5Q",
//   "em_id":            "xyz789"
// }
//
// RETURNS:
// {
//   "overall_status":      "pending",
//   "progress":            "1/2",
//   "percent_complete":    50,
//   "is_complete":         false,
//   "next_display_label":  "CEO",
//   "next_user_id":        null,
//   "next_user_name":      "CEO",
//   "can_approve":         true,
//   "approve_reason":      "user_is_next_approver",
//   "approve_step_number": 2,
//   "approve_role":        "tre.auth.ceo",
//   "can_edit":            false,
//   "edit_reason":         "request_in_review",
//   "can_cancel":          false,
//   "cancel_reason":       "not_requestor"
// }
//
function getChangeRequestProgress(data) {
  var approvalSteps  = ensureArray(data.approval_steps);
  var completedSteps = ensureArray(data.completed_steps);
  var rejectedStep   = data.rejected_step;
  var autoApproved   = data.auto_approved || false;
  var requestStatus  = normalize(data.request_status || "");
  var approverId     = data.approver_id;
  var requestorId    = data.requestor_id;

  // ── Overall status ──────────────────────────────────────────────────────────
  var total      = approvalSteps.length;
  var doneCount  = completedSteps.length;
  var overallStatus;
  var isComplete = false;
  var pct = 0;

  if (autoApproved) {
    overallStatus = "auto_approved";
    isComplete    = true;
    pct           = 100;
  } else if (rejectedStep != null && rejectedStep !== "" && rejectedStep !== false) {
    overallStatus = "rejected";
    isComplete    = true;
    pct           = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  } else if (requestStatus === "approved") {
    overallStatus = "approved";
    isComplete    = true;
    pct           = 100;
  } else if (requestStatus === "cancelled") {
    overallStatus = "cancelled";
    isComplete    = true;
    pct           = 0;
  } else {
    var allDone = total > 0 && doneCount >= total;
    overallStatus = allDone ? "approved" : (requestStatus === "review" ? "pending" : requestStatus);
    isComplete    = allDone;
    pct           = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  }

  // ── Next pending step ───────────────────────────────────────────────────────
  var nextStep = isComplete ? null : getNextStep(approvalSteps, completedSteps);
  var nextDisplayLabel = nextStep ? (ROLE_LABELS[nextStep.role] || nextStep.role) : "All approvals complete";
  var nextUserId   = nextStep ? (nextStep.user_id   || null) : null;
  var nextUserName = nextStep ? (nextStep.user_name  || null) : null;

  // ── Can approve ─────────────────────────────────────────────────────────────
  var approveResult = canUserApproveInternal(data);

  // ── Can edit ────────────────────────────────────────────────────────────────
  var canEdit   = false;
  var editReason = "request_not_draft";
  if (requestStatus === "draft") {
    if (sameUser(approverId, requestorId)) {
      canEdit    = true;
      editReason = "requestor_can_edit";
    } else {
      editReason = "only_requestor_can_edit";
    }
  } else if (requestStatus === "review") {
    editReason = "request_in_review";
  }

  // ── Can cancel ──────────────────────────────────────────────────────────────
  var canCancel    = false;
  var cancelReason = "request_already_final";
  if (requestStatus === "draft" || requestStatus === "review") {
    var approverRoles = parseRoles(data.approver_roles);
    var isCeo = approverRoles.indexOf(CEO_ROLE) !== -1;
    if (sameUser(approverId, requestorId) || isCeo) {
      canCancel    = true;
      cancelReason = sameUser(approverId, requestorId) ? "requestor_can_cancel" : "ceo_can_cancel";
    } else {
      cancelReason = "only_requestor_or_ceo_can_cancel";
    }
  }

  return {
    overall_status:      overallStatus,
    progress:            doneCount + "/" + total,
    percent_complete:    pct,
    is_complete:         isComplete,
    next_display_label:  nextDisplayLabel,
    next_user_id:        nextUserId,
    next_user_name:      nextUserName,
    can_approve:         approveResult.can_approve,
    approve_reason:      approveResult.reason,
    approve_step_number: approveResult.step_number,
    approve_role:        approveResult.role,
    can_edit:            canEdit,
    edit_reason:         editReason,
    can_cancel:          canCancel,
    cancel_reason:       cancelReason
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION C: validateChangeRequest
// ═══════════════════════════════════════════════════════════════════════════════
//
// Pre-submit validation. Checks all line items for naming conflicts and
// constraint violations before the request can be submitted.
//
// PAYLOAD:
// {
//   "items": [
//     {
//       "change_type":            "new_subcategory" | "adjust",
//       "target_subcategory_id":  "",
//       "target_category_id":     "",
//       "new_category_name":      "Marketing",
//       "new_subcategory_name":   "Digital Ads",
//       "amount_delta":           5000,
//       "original_amount":        0,
//       "would_violate":          false
//     }
//   ],
//   "existing_categories": [
//     {
//       "id":   "cat-1",
//       "category": "Operations",
//       "subcategories": [
//         { "id": "sub-1", "name": "Salaries" },
//         { "id": "sub-2", "name": "Rent" }
//       ]
//     }
//   ]
// }
//
// RETURNS:
// {
//   "can_submit": false,
//   "errors":   ["Category \"Marketing\" already exists in this budget."],
//   "warnings": []
// }
//
function validateChangeRequest(data) {
  var items              = ensureArray(data.items);
  var existingCategories = ensureArray(data.existing_categories);
  var errors   = [];
  var warnings = [];

  // Check 1: Must have at least one item
  if (items.length === 0) {
    return { can_submit: false, errors: ["Change request must have at least one line item."], warnings: [] };
  }

  // Build lookup maps from existing budget data
  var existingCatMap = {};   // normalized name → category id
  var existingSubMap = {};   // category_id → [normalized subcategory names]

  existingCategories.forEach(function(cat) {
    var catKey = normalize(cat.category || cat.name || "");
    if (catKey) existingCatMap[catKey] = cat.id;
    var subs = ensureArray(cat.subcategories);
    existingSubMap[cat.id] = subs.map(function(s) { return normalize(s.name || ""); });
  });

  // Check 2: Violation constraints on adjust items (would reduce below reserved + spent)
  var violatingCount = 0;
  items.forEach(function(item) {
    if (item.would_violate === true || item.would_violate === "true") violatingCount++;
  });
  if (violatingCount > 0) {
    errors.push(violatingCount + " item(s) would reduce a subcategory below its committed amount (reserved + spent).");
  }

  // Check 3: Duplicate adjust targets (same subcategory adjusted more than once)
  var adjustTargets = [];
  items.forEach(function(item) {
    if (item.change_type !== "adjust") return;
    var sid = (item.target_subcategory_id || "").trim();
    if (!sid) {
      errors.push("An adjustment item has no target subcategory selected.");
      return;
    }
    if (adjustTargets.indexOf(sid) !== -1) {
      errors.push("The same subcategory cannot be adjusted more than once in a single request.");
    } else {
      adjustTargets.push(sid);
    }
  });

  // Checks 4–9: new_subcategory items
  var newCatSubMap      = {};  // normalized new_cat_name → [normalized sub names in this request]
  var existingCatSubMap = {};  // target_category_id → [normalized sub names in this request]

  items.forEach(function(item) {
    if (item.change_type !== "new_subcategory") return;

    var newCatName  = normalize(item.new_category_name   || "");
    var targetCatId = (item.target_category_id            || "").trim();
    var newSubName  = normalize(item.new_subcategory_name || "");

    // Check 4: Must specify exactly one of: existing category OR new category name
    if (!newCatName && !targetCatId) {
      errors.push("A new subcategory item must specify either an existing category or a new category name.");
      return;
    }
    if (newCatName && targetCatId) {
      errors.push("A new subcategory item cannot specify both a new category name and an existing category.");
      return;
    }

    // Check 5: Subcategory name required
    if (!newSubName) {
      errors.push("A new subcategory item must have a name.");
      return;
    }

    if (newCatName) {
      // New subcategory under a NEW category

      // Check 6: New category name conflicts with an existing category on this budget
      if (existingCatMap.hasOwnProperty(newCatName)) {
        errors.push(
          "Category \"" + (item.new_category_name || newCatName) +
          "\" already exists in this budget. Select it as the existing category instead."
        );
        return;
      }

      // Check 7: Duplicate subcategory name under the same new category within this request
      if (!newCatSubMap[newCatName]) newCatSubMap[newCatName] = [];
      if (newCatSubMap[newCatName].indexOf(newSubName) !== -1) {
        errors.push(
          "Subcategory \"" + (item.new_subcategory_name || newSubName) +
          "\" is used more than once under new category \"" + (item.new_category_name || newCatName) + "\" in this request."
        );
      } else {
        newCatSubMap[newCatName].push(newSubName);
      }

    } else {
      // New subcategory under an EXISTING category

      // Check 8: Conflicts with existing subcategories under the same parent
      var existingUnderParent = existingSubMap[targetCatId] || [];
      if (existingUnderParent.indexOf(newSubName) !== -1) {
        errors.push(
          "Subcategory \"" + (item.new_subcategory_name || newSubName) +
          "\" already exists under this category."
        );
      }

      // Check 9: Duplicate within same existing parent in this request
      if (!existingCatSubMap[targetCatId]) existingCatSubMap[targetCatId] = [];
      if (existingCatSubMap[targetCatId].indexOf(newSubName) !== -1) {
        errors.push(
          "Subcategory \"" + (item.new_subcategory_name || newSubName) +
          "\" appears more than once under the same category in this request."
        );
      } else {
        existingCatSubMap[targetCatId].push(newSubName);
      }
    }
  });

  return {
    can_submit: errors.length === 0,
    errors:     errors,
    warnings:   warnings
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════
window.function = function(function_name, payload) {
  var rawFn      = (function_name  && function_name.value  !== undefined) ? function_name.value  : function_name;
  var rawPayload = (payload        && payload.value        !== undefined) ? payload.value        : payload;

  var data;
  try {
    data = typeof rawPayload === "string" ? JSON.parse(rawPayload) : (rawPayload || {});
  } catch (e) {
    return JSON.stringify({ error: "Invalid JSON payload: " + e.toString() });
  }

  var fn = (rawFn || "").trim();
  var result;

  if (fn === "getChangeRequestChain" || fn === "A") {
    result = getChangeRequestChain(data);
  } else if (fn === "getChangeRequestProgress" || fn === "B") {
    result = getChangeRequestProgress(data);
  } else if (fn === "validateChangeRequest" || fn === "C") {
    result = validateChangeRequest(data);
  } else {
    result = { error: "Unknown function: \"" + fn + "\". Valid names: getChangeRequestChain, getChangeRequestProgress, validateChangeRequest" };
  }

  return JSON.stringify(result);
};
