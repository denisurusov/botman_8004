// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IIdentityRegistry.sol";
import "./ExecutionTraceLog.sol";

/**
 * @title CodeReviewerOracle
 * @notice On-chain request/response contract for the code-reviewer MCP agent type.
 *
 * Distributed tracing: every request carries a `bytes32 traceId` correlation token.
 * If an ExecutionTraceLog is configured, hops are recorded automatically.
 *
 * fulfillReview uses viaIR to handle the deep stack.
 */
contract CodeReviewerOracle {

    enum RequestStatus { Pending, Fulfilled, Cancelled }

    struct ReviewRequest {
        address requester;
        string  prId;
        bytes32 traceId;
        string  focus;
        uint256 createdAt;
        RequestStatus status;
    }

    struct ReviewResult {
        bytes32 traceId;
        bytes   summary;
        bytes   comments;
        bool    approved;
        uint256 agentId;
        uint256 fulfilledAt;
    }

    address public owner;
    IIdentityRegistry public identityRegistry;
    ExecutionTraceLog public traceLog;

    mapping(bytes32 => ReviewRequest) public requests;
    mapping(bytes32 => ReviewResult)  public results;
    mapping(string => bytes) public reviewComments;
    mapping(string => bytes) public reviewDiff;

    uint256 private _nonce;

    event ReviewRequested(bytes32 indexed requestId, address indexed requester, string prId, bytes32 indexed traceId, string focus, uint256 timestamp);
    event ReviewFulfilled(bytes32 indexed requestId, bytes32 indexed traceId, bool approved, uint256 agentId, uint256 timestamp);
    event ReviewCancelled(bytes32 indexed requestId);
    event DiffStored(string prId, address storedBy);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    modifier onlyRegisteredOracle(uint256 agentId) {
        require(identityRegistry.getAgentWallet(agentId) == msg.sender, "not agentWallet");
        require(identityRegistry.getOracleAddress(agentId) == address(this), "not bound oracle");
        _;
    }

    constructor(address identityRegistry_, address traceLog_) {
        require(identityRegistry_ != address(0), "zero registry");
        owner = msg.sender;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        traceLog = ExecutionTraceLog(traceLog_);
    }

    function requestReview(string calldata prId, bytes32 traceId, string calldata focus)
        external returns (bytes32 requestId)
    {
        require(bytes(prId).length > 0, "prId required");
        if (traceId == bytes32(0)) {
            traceId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce));
        }
        requestId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce++));
        requests[requestId] = ReviewRequest(msg.sender, prId, traceId, focus, block.timestamp, RequestStatus.Pending);
        emit ReviewRequested(requestId, msg.sender, prId, traceId, focus, block.timestamp);
        _recordHop(traceId, 0, "reviewRequested");
    }

    function fulfillReview(
        uint256 agentId, bytes32 requestId, string calldata prId,
        bytes calldata summaryJson, bytes calldata commentsJson, bool approved
    ) external onlyRegisteredOracle(agentId) {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        require(req.status == RequestStatus.Pending, "not pending");
        require(keccak256(bytes(req.prId)) == keccak256(bytes(prId)), "prId mismatch");

        bytes32 traceId = req.traceId;
        req.status = RequestStatus.Fulfilled;

        results[requestId] = ReviewResult(traceId, summaryJson, commentsJson, approved, agentId, block.timestamp);
        reviewComments[prId] = commentsJson;

        emit ReviewFulfilled(requestId, traceId, approved, agentId, block.timestamp);
        _recordHop(traceId, agentId, "reviewFulfilled");
    }

    function getRequestInfo(bytes32 requestId) external view
        returns (RequestStatus status, string memory prId, bytes32 traceId, address requester, uint256 createdAt)
    {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        return (req.status, req.prId, req.traceId, req.requester, req.createdAt);
    }

    function getResultInfo(bytes32 requestId) external view
        returns (bool approved, bytes memory summary, bytes memory comments, uint256 agentId, uint256 fulfilledAt)
    {
        require(requests[requestId].createdAt != 0, "unknown requestId");
        ReviewResult storage res = results[requestId];
        return (res.approved, res.summary, res.comments, res.agentId, res.fulfilledAt);
    }

    function getComments(string calldata prId) external view returns (bytes memory) { return reviewComments[prId]; }

    function storeDiff(string calldata prId, bytes calldata diff) external {
        require(bytes(prId).length > 0, "prId required");
        reviewDiff[prId] = diff;
        emit DiffStored(prId, msg.sender);
    }

    function getDiff(string calldata prId) external view returns (bytes memory) { return reviewDiff[prId]; }

    function cancelReview(bytes32 requestId) external {
        ReviewRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        require(req.requester == msg.sender, "not requester");
        require(req.status == RequestStatus.Pending, "not pending");
        req.status = RequestStatus.Cancelled;
        emit ReviewCancelled(requestId);
    }

    function _recordHop(bytes32 traceId, uint256 agentId, string memory action) internal {
        if (address(traceLog) != address(0)) traceLog.recordHop(traceId, agentId, action);
    }
}
