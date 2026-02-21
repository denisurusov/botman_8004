// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CodeReviewerOracle
 * @notice Monolithic on-chain request/response contract for the code-reviewer MCP agent type.
 *
 * Flow:
 *   1. Any caller calls requestReview(prId, focus) — emits ReviewRequested.
 *   2. Off-chain MCP server (oracle) sees the event, runs the review_pr tool, then
 *      calls fulfillReview(requestId, prId, summaryJson, commentsJson, approved).
 *   3. Result is stored as raw JSON bytes and accessible via getReview() / getComments().
 *
 * Resources exposed on-chain (mirror of MCP resources):
 *   review://{pr_id}/comments  →  reviewComments[prId]
 *   review://{pr_id}/diff      →  diff is supplied by the oracle as part of fulfillment context;
 *                                  callers may also store a diff hint via storeDiff().
 *
 * Authorization:
 *   Only addresses registered as oracles (via addOracle / removeOracle) may call fulfill*.
 *   The contract owner manages the oracle set.
 */
contract CodeReviewerOracle {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum RequestStatus { Pending, Fulfilled, Cancelled }

    struct ReviewRequest {
        address requester;
        string  prId;
        string  focus;          // comma-separated focus areas, empty = all
        uint256 createdAt;
        RequestStatus status;
    }

    struct ReviewResult {
        string  prId;
        bytes   summary;        // raw JSON string  – MCP outputSchema: summary
        bytes   comments;       // raw JSON array   – MCP outputSchema: comments[]
        bool    approved;       // MCP outputSchema: approved
        address oracle;
        uint256 fulfilledAt;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public owner;

    /// oracle address → authorised flag
    mapping(address => bool) public isOracle;

    /// requestId → request metadata
    mapping(bytes32 => ReviewRequest) public requests;

    /// requestId → review result (populated on fulfillment)
    mapping(bytes32 => ReviewResult) public results;

    /// MCP resource: review://{pr_id}/comments  (latest fulfilled comments per PR)
    mapping(string => bytes) public reviewComments;

    /// MCP resource: review://{pr_id}/diff  (latest diff stored for a PR)
    mapping(string => bytes) public reviewDiff;

    /// nonce used to generate unique requestIds
    uint256 private _nonce;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// Emitted when a caller requests a review — oracle monitors this event.
    event ReviewRequested(
        bytes32 indexed requestId,
        address indexed requester,
        string  prId,
        string  focus,
        uint256 timestamp
    );

    /// Emitted when the oracle fulfils a review.
    event ReviewFulfilled(
        bytes32 indexed requestId,
        string  prId,
        bool    approved,
        address oracle,
        uint256 timestamp
    );

    /// Emitted when a request is cancelled by its requester.
    event ReviewCancelled(bytes32 indexed requestId, string prId);

    /// Emitted when a diff is stored for a PR.
    event DiffStored(string indexed prId, address storedBy);

    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "CodeReviewerOracle: not owner");
        _;
    }

    modifier onlyOracle() {
        require(isOracle[msg.sender], "CodeReviewerOracle: not an authorised oracle");
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
    // MCP Tool: review_pr  — request side
    // -------------------------------------------------------------------------

    /**
     * @notice Request a code review for a pull request.
     * @param prId   Pull request identifier (e.g. "42" or "org/repo#42").
     * @param focus  Comma-separated focus areas: "bugs,security,style,performance,tests,documentation".
     *               Pass an empty string to cover all areas.
     * @return requestId Unique identifier for this request, emitted in ReviewRequested.
     */
    function requestReview(string calldata prId, string calldata focus)
        external
        returns (bytes32 requestId)
    {
        require(bytes(prId).length > 0, "CodeReviewerOracle: prId required");

        requestId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce++));

        requests[requestId] = ReviewRequest({
            requester:  msg.sender,
            prId:       prId,
            focus:      focus,
            createdAt:  block.timestamp,
            status:     RequestStatus.Pending
        });

        emit ReviewRequested(requestId, msg.sender, prId, focus, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: review_pr  — fulfillment side (oracle callback)
    // -------------------------------------------------------------------------

    /**
     * @notice Called by the MCP oracle to deliver the review result on-chain.
     * @param requestId    The requestId from the original ReviewRequested event.
     * @param prId         Pull request identifier (must match the request).
     * @param summaryJson  Raw JSON string matching MCP outputSchema `summary` field.
     * @param commentsJson Raw JSON array matching MCP outputSchema `comments[]` field.
     * @param approved     Whether the reviewer recommends approval.
     */
    function fulfillReview(
        bytes32        requestId,
        string calldata prId,
        bytes  calldata summaryJson,
        bytes  calldata commentsJson,
        bool            approved
    )
        external
        onlyOracle
    {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0,                         "CodeReviewerOracle: unknown requestId");
        require(req.status == RequestStatus.Pending,        "CodeReviewerOracle: request not pending");
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
            oracle:      msg.sender,
            fulfilledAt: block.timestamp
        });

        // Update MCP resource: review://{pr_id}/comments
        reviewComments[prId] = commentsJson;

        emit ReviewFulfilled(requestId, prId, approved, msg.sender, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // MCP Tool: get_review_status
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the status and result of a review request.
     * @param requestId The request to query.
     * @return status     Current RequestStatus.
     * @return prId       Pull request identifier.
     * @return approved   Reviewer's recommendation (only meaningful when Fulfilled).
     * @return summary    Raw JSON summary bytes.
     * @return comments   Raw JSON comments array bytes.
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
            uint256 fulfilledAt
        )
    {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0, "CodeReviewerOracle: unknown requestId");

        ReviewResult storage res = results[requestId];
        return (
            req.status,
            req.prId,
            res.approved,
            res.summary,
            res.comments,
            res.fulfilledAt
        );
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
        require(req.createdAt != 0,                   "CodeReviewerOracle: unknown requestId");
        require(req.requester == msg.sender,           "CodeReviewerOracle: not requester");
        require(req.status == RequestStatus.Pending,  "CodeReviewerOracle: not pending");

        req.status = RequestStatus.Cancelled;
        emit ReviewCancelled(requestId, req.prId);
    }
}

