// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IIdentityRegistry.sol";

/**
 * @title CodeReviewerOracle
 * @notice Monolithic on-chain request/response contract for the code-reviewer MCP agent type.
 *
 * Authorization model (ERC-8004 Option A):
 *   Instead of a raw address whitelist, oracle authorization is verified through the
 *   IdentityRegistryUpgradeable.  A caller may fulfill a request only if:
 *     1. They are the agentWallet of a registered agent (agentId), AND
 *     2. The oracleAddress bound to that agentId equals address(this).
 *   This means registration in the identity registry IS the oracle authorization —
 *   no separate addOracle() call needed.
 *
 * Flow:
 *   1. Any caller calls requestReview(prId, focus) — emits ReviewRequested.
 *   2. Off-chain MCP server (oracle) sees the event, runs the review_pr tool, then
 *      calls fulfillReview(agentId, requestId, prId, summaryJson, commentsJson, approved).
 *   3. Result is stored as raw JSON bytes and accessible via getReview() / getComments().
 *
 * Resources exposed on-chain (mirror of MCP resources):
 *   review://{pr_id}/comments  →  reviewComments[prId]
 *   review://{pr_id}/diff      →  reviewDiff[prId]
 */
contract CodeReviewerOracle {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum RequestStatus { Pending, Fulfilled, Cancelled }

    struct ReviewRequest {
        address requester;
        string  prId;
        string  focus;
        uint256 createdAt;
        RequestStatus status;
    }

    struct ReviewResult {
        string  prId;
        bytes   summary;
        bytes   comments;
        bool    approved;
        uint256 agentId;    // identity registry agentId of the fulfilling oracle
        uint256 fulfilledAt;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public owner;
    IIdentityRegistry public identityRegistry;

    mapping(bytes32 => ReviewRequest) public requests;
    mapping(bytes32 => ReviewResult)  public results;

    /// MCP resource: review://{pr_id}/comments
    mapping(string => bytes) public reviewComments;
    /// MCP resource: review://{pr_id}/diff
    mapping(string => bytes) public reviewDiff;

    uint256 private _nonce;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ReviewRequested(
        bytes32 indexed requestId,
        address indexed requester,
        string  prId,
        string  focus,
        uint256 timestamp
    );
    event ReviewFulfilled(
        bytes32 indexed requestId,
        string  prId,
        bool    approved,
        uint256 indexed agentId,
        uint256 timestamp
    );
    event ReviewCancelled(bytes32 indexed requestId, string prId);
    event DiffStored(string indexed prId, address storedBy);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "CodeReviewerOracle: not owner");
        _;
    }

    /**
     * @dev Verifies the caller is:
     *   (a) the agentWallet registered for agentId in the identity registry, AND
     *   (b) the oracleAddress bound to that agentId is this contract.
     */
    modifier onlyRegisteredOracle(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "CodeReviewerOracle: caller is not the registered agentWallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "CodeReviewerOracle: agentId not bound to this oracle"
        );
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "CodeReviewerOracle: zero registry");
        owner            = msg.sender;
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: review_pr — request side
    // -------------------------------------------------------------------------

    /**
     * @notice Request a code review for a pull request.
     * @param prId   Pull request identifier.
     * @param focus  Comma-separated focus areas. Empty = all.
     * @return requestId Unique identifier for this request.
     */
    function requestReview(string calldata prId, string calldata focus)
        external
        returns (bytes32 requestId)
    {
        require(bytes(prId).length > 0, "CodeReviewerOracle: prId required");

        requestId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce++));

        requests[requestId] = ReviewRequest({
            requester: msg.sender,
            prId:      prId,
            focus:     focus,
            createdAt: block.timestamp,
            status:    RequestStatus.Pending
        });

        emit ReviewRequested(requestId, msg.sender, prId, focus, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: review_pr — fulfillment side (oracle callback)
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the MCP oracle bridge to deliver the review result on-chain.
     * @param agentId      The ERC-8004 agentId of the calling oracle (verified against registry).
     * @param requestId    The requestId from the original ReviewRequested event.
     * @param prId         Pull request identifier (must match the request).
     * @param summaryJson  Raw JSON bytes — MCP outputSchema `summary`.
     * @param commentsJson Raw JSON array  — MCP outputSchema `comments[]`.
     * @param approved     Whether the reviewer recommends approval.
     */
    function fulfillReview(
        uint256         agentId,
        bytes32         requestId,
        string calldata prId,
        bytes  calldata summaryJson,
        bytes  calldata commentsJson,
        bool            approved
    )
        external
        onlyRegisteredOracle(agentId)
    {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0,                  "CodeReviewerOracle: unknown requestId");
        require(req.status == RequestStatus.Pending, "CodeReviewerOracle: request not pending");
        require(
            keccak256(bytes(req.prId)) == keccak256(bytes(prId)),
            "CodeReviewerOracle: prId mismatch"
        );

        req.status = RequestStatus.Fulfilled;

        results[requestId] = ReviewResult({
            prId:        prId,
            summary:     summaryJson,
            comments:    commentsJson,
            approved:    approved,
            agentId:     agentId,
            fulfilledAt: block.timestamp
        });

        // Update MCP resource: review://{pr_id}/comments
        reviewComments[prId] = commentsJson;

        emit ReviewFulfilled(requestId, prId, approved, agentId, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: get_review_status
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the status and result of a review request.
     * @param requestId The request to query.
     * @return status      Current RequestStatus.
     * @return prId        Pull request identifier.
     * @return approved    Reviewer's recommendation (only meaningful when Fulfilled).
     * @return summary     Raw JSON summary bytes.
     * @return comments    Raw JSON comments array bytes.
     * @return agentId     ERC-8004 agentId of the fulfilling oracle.
     * @return fulfilledAt Timestamp of fulfillment (0 if not yet fulfilled).
     */
    function getReview(bytes32 requestId)
        external
        view
        returns (
            RequestStatus status,
            string  memory prId,
            bool    approved,
            bytes   memory summary,
            bytes   memory comments,
            uint256 agentId,
            uint256 fulfilledAt
        )
    {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0, "CodeReviewerOracle: unknown requestId");
        ReviewResult storage res = results[requestId];
        return (req.status, req.prId, res.approved, res.summary, res.comments, res.agentId, res.fulfilledAt);
    }

    // -------------------------------------------------------------------------
    // MCP Resource: review://{pr_id}/comments
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the latest review comments for a PR (raw JSON bytes).
     *         Maps to MCP resource review://{pr_id}/comments.
     */
    function getComments(string calldata prId)
        external
        view
        returns (bytes memory)
    {
        return reviewComments[prId];
    }

    // -------------------------------------------------------------------------
    // MCP Resource: review://{pr_id}/diff
    // -------------------------------------------------------------------------

    /**
     * @notice Store the raw diff for a PR on-chain.
     *         Maps to MCP resource review://{pr_id}/diff.
     *         Callers may store the diff before requesting a review so the oracle
     *         can read it directly from the chain if needed.
     */
    function storeDiff(string calldata prId, bytes calldata diff) external {
        require(bytes(prId).length > 0, "CodeReviewerOracle: prId required");
        reviewDiff[prId] = diff;
        emit DiffStored(prId, msg.sender);
    }

    /**
     * @notice Read the stored diff for a PR.
     */
    function getDiff(string calldata prId)
        external
        view
        returns (bytes memory)
    {
        return reviewDiff[prId];
    }

    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------

    /**
     * @notice Cancel a pending review request. Only the original requester may cancel.
     */
    function cancelReview(bytes32 requestId) external {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0,                  "CodeReviewerOracle: unknown requestId");
        require(req.requester == msg.sender,          "CodeReviewerOracle: not requester");
        require(req.status == RequestStatus.Pending, "CodeReviewerOracle: not pending");
        req.status = RequestStatus.Cancelled;
        emit ReviewCancelled(requestId, req.prId);
    }
}
