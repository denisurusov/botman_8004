// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IIdentityRegistry.sol";

/**
 * @title CodeApproverOracle
 * @notice Monolithic on-chain request/response contract for the code-approver MCP agent type.
 *
 * Authorization model (ERC-8004 Option A):
 *   A caller may fulfill a request only if:
 *     1. They are the agentWallet of a registered agent (agentId), AND
 *     2. The oracleAddress bound to that agentId equals address(this).
 *   Registration in the identity registry IS the oracle authorization.
 *
 * Flow:
 *   1. Any caller calls requestApproval(prId, reviewerAgent, message) — emits ApprovalRequested.
 *   2. Off-chain MCP approver bridge sees the event, calls approve_pr on the MCP server,
 *      then calls fulfillApproval / fulfillNeedsRevision / fulfillRejection.
 *   3. Decision is stored as raw JSON bytes.
 *
 * Resources:
 *   approval://{pr_id}/decision  →  approvalDecisions[prId]
 */
contract CodeApproverOracle {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum RequestStatus { Pending, Approved, NeedsRevision, Rejected, Cancelled }

    struct ApprovalRequest {
        address requester;
        string  prId;
        string  reviewerAgent;
        string  message;
        uint256 createdAt;
        RequestStatus status;
    }

    struct ApprovalResult {
        string  prId;
        bytes   decision;
        bytes   reason;
        bytes   unresolvedBlockers;
        uint256 agentId;    // identity registry agentId of the fulfilling oracle
        uint256 fulfilledAt;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public owner;
    IIdentityRegistry public identityRegistry;

    mapping(bytes32 => ApprovalRequest) public requests;
    mapping(bytes32 => ApprovalResult)  public results;

    /// MCP resource: approval://{pr_id}/decision
    mapping(string => bytes) public approvalDecisions;

    uint256 private _nonce;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ApprovalRequested(
        bytes32 indexed requestId,
        address indexed requester,
        string  prId,
        string  reviewerAgent,
        uint256 timestamp
    );
    event PRApproved(
        bytes32 indexed requestId,
        string  prId,
        uint256 indexed agentId,
        uint256 timestamp
    );
    event RevisionRequested(
        bytes32 indexed requestId,
        string  prId,
        bytes   unresolvedBlockers,
        uint256 indexed agentId,
        uint256 timestamp
    );
    event PRRejected(
        bytes32 indexed requestId,
        string  prId,
        bytes   reason,
        uint256 indexed agentId,
        uint256 timestamp
    );
    event ApprovalCancelled(bytes32 indexed requestId, string prId);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "CodeApproverOracle: not owner");
        _;
    }

    modifier onlyRegisteredOracle(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "CodeApproverOracle: caller is not the registered agentWallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "CodeApproverOracle: agentId not bound to this oracle"
        );
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "CodeApproverOracle: zero registry");
        owner            = msg.sender;
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: approve_pr — request side
    // -------------------------------------------------------------------------

    /**
     * @notice Request an approval decision for a pull request.
     * @param prId          Pull request identifier.
     * @param reviewerAgent Endpoint hint for the approver oracle (e.g. "http://localhost:8001").
     * @param message       Optional message from the requester.
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
    // MCP Tool: approve_pr — fulfillment callbacks (oracle)
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the oracle when the PR is approved with no blocking issues.
     * @param agentId    ERC-8004 agentId of the calling oracle.
     * @param requestId  The requestId from the original ApprovalRequested event.
     * @param prId       Pull request identifier.
     * @param reasonJson Raw JSON bytes for the approval reason.
     */
    function fulfillApproval(
        uint256         agentId,
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson
    )
        external
        onlyRegisteredOracle(agentId)
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.Approved;

        bytes memory decisionBytes = bytes('"approved"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, bytes("[]"), agentId);
        approvalDecisions[prId] = decisionBytes;

        emit PRApproved(requestId, prId, agentId, block.timestamp);
    }

    /**
     * @notice Called by the oracle when the PR needs revision.
     * @param agentId        ERC-8004 agentId of the calling oracle.
     * @param requestId      The requestId from the original ApprovalRequested event.
     * @param prId           Pull request identifier.
     * @param reasonJson     Raw JSON bytes for the reason.
     * @param unresolvedJson Raw JSON array of unresolved blocker descriptions.
     */
    function fulfillNeedsRevision(
        uint256         agentId,
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson,
        bytes  calldata unresolvedJson
    )
        external
        onlyRegisteredOracle(agentId)
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.NeedsRevision;

        bytes memory decisionBytes = bytes('"needs_revision"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, unresolvedJson, agentId);
        approvalDecisions[prId] = decisionBytes;

        emit RevisionRequested(requestId, prId, unresolvedJson, agentId, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: reject_pr — fulfillment callback
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the oracle when the PR is fundamentally rejected.
     * @param agentId    ERC-8004 agentId of the calling oracle.
     * @param requestId  The requestId from the original ApprovalRequested event.
     * @param prId       Pull request identifier.
     * @param reasonJson Raw JSON bytes explaining the rejection.
     */
    function fulfillRejection(
        uint256         agentId,
        bytes32         requestId,
        string calldata prId,
        bytes  calldata reasonJson
    )
        external
        onlyRegisteredOracle(agentId)
    {
        ApprovalRequest storage req = _requirePending(requestId, prId);
        req.status = RequestStatus.Rejected;

        bytes memory decisionBytes = bytes('"rejected"');
        _storeResult(requestId, prId, decisionBytes, reasonJson, bytes("[]"), agentId);
        approvalDecisions[prId] = decisionBytes;

        emit PRRejected(requestId, prId, reasonJson, agentId, block.timestamp);
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
     * @return status             Current RequestStatus.
     * @return prId               Pull request identifier.
     * @return decision           Raw JSON decision bytes.
     * @return reason             Raw JSON reason bytes.
     * @return unresolvedBlockers Raw JSON array of unresolved blockers.
     * @return agentId            ERC-8004 agentId of the fulfilling oracle.
     * @return fulfilledAt        Timestamp of fulfillment (0 if not yet fulfilled).
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
            uint256        agentId,
            uint256        fulfilledAt
        )
    {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0, "CodeApproverOracle: unknown requestId");
        ApprovalResult storage res = results[requestId];
        return (req.status, req.prId, res.decision, res.reason, res.unresolvedBlockers, res.agentId, res.fulfilledAt);
    }

    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------

    /**
     * @notice Cancel a pending approval request. Only the original requester may cancel.
     */
    function cancelApproval(bytes32 requestId) external {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0,                  "CodeApproverOracle: unknown requestId");
        require(req.requester == msg.sender,          "CodeApproverOracle: not requester");
        require(req.status == RequestStatus.Pending, "CodeApproverOracle: not pending");
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
        require(req.createdAt != 0,                  "CodeApproverOracle: unknown requestId");
        require(req.status == RequestStatus.Pending, "CodeApproverOracle: request not pending");
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
        bytes memory unresolvedBlockers,
        uint256 agentId
    ) internal {
        results[requestId] = ApprovalResult({
            prId:               prId,
            decision:           decision,
            reason:             reason,
            unresolvedBlockers: unresolvedBlockers,
            agentId:            agentId,
            fulfilledAt:        block.timestamp
        });
    }
}
