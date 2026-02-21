// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CodeApproverOracle
 * @notice Monolithic on-chain request/response contract for the code-approver MCP agent type.
 *
 * Flow:
 *   1. Any caller calls requestApproval(prId, reviewerAgent, message) — emits ApprovalRequested.
 *   2. Off-chain MCP approver agent sees the event, reads reviewer comments (optionally from
 *      the companion CodeReviewerOracle), runs approve_pr or reject_pr, then calls back either
 *      fulfillApproval() or fulfillRejection().
 *   3. Decision is stored as raw JSON bytes and accessible via getDecision().
 *
 * Resources exposed on-chain (mirror of MCP resources):
 *   review://{pr_id}/comments    →  read from the CodeReviewerOracle (address set at construction)
 *   approval://{pr_id}/decision  →  approvalDecisions[prId]
 *
 * Authorization:
 *   Only addresses registered as oracles may call fulfill*.
 *   The contract owner manages the oracle set.
 */
contract CodeApproverOracle {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum RequestStatus { Pending, Approved, NeedsRevision, Rejected, Cancelled }

    struct ApprovalRequest {
        address requester;
        string  prId;
        string  reviewerAgent;  // endpoint hint for the approver oracle
        string  message;        // optional message from requester
        uint256 createdAt;
        RequestStatus status;
    }

    struct ApprovalResult {
        string  prId;
        /// Raw JSON string — MCP outputSchema: decision enum value
        bytes   decision;
        /// Raw JSON string — MCP outputSchema: reason
        bytes   reason;
        /// Raw JSON array  — MCP outputSchema: unresolved_blockers[]
        bytes   unresolvedBlockers;
        address oracle;
        uint256 fulfilledAt;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public owner;

    mapping(address => bool) public isOracle;

    mapping(bytes32 => ApprovalRequest) public requests;
    mapping(bytes32 => ApprovalResult)  public results;

    /// MCP resource: approval://{pr_id}/decision  (latest decision per PR)
    mapping(string => bytes) public approvalDecisions;

    uint256 private _nonce;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// Emitted when a caller requests an approval — oracle monitors this event.
    event ApprovalRequested(
        bytes32 indexed requestId,
        address indexed requester,
        string  prId,
        string  reviewerAgent,
        uint256 timestamp
    );

    /// Emitted when the oracle approves a PR.
    event PRApproved(
        bytes32 indexed requestId,
        string  prId,
        address oracle,
        uint256 timestamp
    );

    /// Emitted when the oracle requests revisions.
    event RevisionRequested(
        bytes32 indexed requestId,
        string  prId,
        bytes   unresolvedBlockers,
        address oracle,
        uint256 timestamp
    );

    /// Emitted when the oracle rejects a PR outright.
    event PRRejected(
        bytes32 indexed requestId,
        string  prId,
        bytes   reason,
        address oracle,
        uint256 timestamp
    );

    /// Emitted when a request is cancelled.
    event ApprovalCancelled(bytes32 indexed requestId, string prId);

    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "CodeApproverOracle: not owner");
        _;
    }

    modifier onlyOracle() {
        require(isOracle[msg.sender], "CodeApproverOracle: not an authorised oracle");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Oracle management
    // -------------------------------------------------------------------------

    function addOracle(address oracle) external onlyOwner {
        isOracle[oracle] = true;
        emit OracleAdded(oracle);
    }

    function removeOracle(address oracle) external onlyOwner {
        isOracle[oracle] = false;
        emit OracleRemoved(oracle);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: approve_pr  — request side
    // -------------------------------------------------------------------------

    /**
     * @notice Request an approval decision for a pull request.
     * @param prId          Pull request identifier.
     * @param reviewerAgent Endpoint of the reviewer agent whose comments should be considered.
     *                      Pass an empty string to let the oracle decide.
     * @param message       Optional message from the requester to the approver.
     * @return requestId    Unique identifier for this request.
     */
    function requestApproval(
        string calldata prId,
        string calldata reviewerAgent,
        string calldata message
    )
        external
        returns (bytes32 requestId)
    {
        require(bytes(prId).length > 0, "CodeApproverOracle: prId required");

        requestId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce++));

        requests[requestId] = ApprovalRequest({
            requester:     msg.sender,
            prId:          prId,
            reviewerAgent: reviewerAgent,
            message:       message,
            createdAt:     block.timestamp,
            status:        RequestStatus.Pending
        });

        emit ApprovalRequested(requestId, msg.sender, prId, reviewerAgent, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: approve_pr  — fulfillment side (oracle callback)
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the oracle when the PR is approved with no blocking issues.
     * @param requestId  The requestId from the original ApprovalRequested event.
     * @param prId       Pull request identifier (must match the request).
     * @param reasonJson Raw JSON bytes for the approval reason/message.
     */
    function fulfillApproval(
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson
    )
        external
        onlyOracle
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.Approved;

        bytes memory decisionBytes = bytes('"approved"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, bytes("[]"));

        approvalDecisions[prId] = decisionBytes;

        emit PRApproved(requestId, prId, msg.sender, block.timestamp);
    }

    /**
     * @notice Called by the oracle when the PR needs revision (blocking issues remain).
     * @param requestId          The requestId from the original ApprovalRequested event.
     * @param prId               Pull request identifier.
     * @param reasonJson         Raw JSON bytes for the reason.
     * @param unresolvedJson     Raw JSON array of unresolved blocker descriptions.
     */
    function fulfillNeedsRevision(
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson,
        bytes  calldata unresolvedJson
    )
        external
        onlyOracle
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.NeedsRevision;

        bytes memory decisionBytes = bytes('"needs_revision"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, unresolvedJson);

        approvalDecisions[prId] = decisionBytes;

        emit RevisionRequested(requestId, prId, unresolvedJson, msg.sender, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: reject_pr  — fulfillment side (oracle callback)
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the oracle when the PR is fundamentally rejected.
     * @param requestId  The requestId from the original ApprovalRequested event.
     * @param prId       Pull request identifier.
     * @param reasonJson Raw JSON bytes explaining the rejection.
     */
    function fulfillRejection(
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson
    )
        external
        onlyOracle
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.Rejected;

        bytes memory decisionBytes = bytes('"rejected"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, bytes("[]"));

        approvalDecisions[prId] = decisionBytes;

        emit PRRejected(requestId, prId, reasonJson, msg.sender, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Resource: approval://{pr_id}/decision
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the latest approval decision for a PR.
     *         Maps to MCP resource approval://{pr_id}/decision.
     * @return Raw JSON bytes of the decision value.
     */
    function getDecision(string calldata prId)
        external
        view
        returns (bytes memory)
    {
        return approvalDecisions[prId];
    }

    /**
     * @notice Returns the full result for a specific request.
     * @param requestId The request to query.
     * @return status            Current RequestStatus.
     * @return prId              Pull request identifier.
     * @return decision          Raw JSON decision bytes.
     * @return reason            Raw JSON reason bytes.
     * @return unresolvedBlockers Raw JSON array of unresolved blockers.
     * @return fulfilledAt       Timestamp of fulfillment (0 if not yet fulfilled).
     */
    function getResult(bytes32 requestId)
        external
        view
        returns (
            RequestStatus  status,
            string  memory prId,
            bytes   memory decision,
            bytes   memory reason,
            bytes   memory unresolvedBlockers,
            uint256        fulfilledAt
        )
    {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0, "CodeApproverOracle: unknown requestId");

        ApprovalResult storage res = results[requestId];
        return (
            req.status,
            req.prId,
            res.decision,
            res.reason,
            res.unresolvedBlockers,
            res.fulfilledAt
        );
    }

    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------

    /**
     * @notice Cancel a pending approval request. Only the original requester may cancel.
     */
    function cancelApproval(bytes32 requestId) external {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0,                   "CodeApproverOracle: unknown requestId");
        require(req.requester == msg.sender,           "CodeApproverOracle: not requester");
        require(req.status == RequestStatus.Pending,  "CodeApproverOracle: not pending");

        req.status = RequestStatus.Cancelled;
        emit ApprovalCancelled(requestId, req.prId);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _requirePending(bytes32 requestId, string calldata prId)
        internal
        view
        returns (ApprovalRequest storage req)
    {
        req = requests[requestId];
        require(req.createdAt != 0,                     "CodeApproverOracle: unknown requestId");
        require(req.status == RequestStatus.Pending,    "CodeApproverOracle: request not pending");
        require(
            keccak256(bytes(req.prId)) == keccak256(bytes(prId)),
            "CodeApproverOracle: prId mismatch"
        );
    }

    function _storeResult(
        bytes32 requestId,
        string calldata prId,
        bytes memory decision,
        bytes calldata reason,
        bytes memory unresolvedBlockers
    ) internal {
        results[requestId] = ApprovalResult({
            prId:              prId,
            decision:          decision,
            reason:            reason,
            unresolvedBlockers: unresolvedBlockers,
            oracle:            msg.sender,
            fulfilledAt:       block.timestamp
        });
    }
}

