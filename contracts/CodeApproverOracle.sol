// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IIdentityRegistry.sol";
import "./ExecutionTraceLog.sol";

/**
 * @title CodeApproverOracle
 * @notice On-chain request/response contract for the code-approver MCP agent type.
 *
 * Distributed tracing: every request carries a `bytes32 traceId` correlation token.
 * The same traceId from the review phase carries through to the approval phase.
 */
contract CodeApproverOracle {

    enum RequestStatus { Pending, Approved, NeedsRevision, Rejected, Cancelled }

    struct ApprovalRequest {
        address requester;
        string  prId;
        bytes32 traceId;
        string  reviewerAgent;
        string  message;
        uint256 createdAt;
        RequestStatus status;
    }

    struct ApprovalResult {
        bytes32 traceId;
        bytes   decision;
        bytes   reason;
        bytes   unresolvedBlockers;
        uint256 agentId;
        uint256 fulfilledAt;
    }

    address public owner;
    IIdentityRegistry public identityRegistry;
    ExecutionTraceLog public traceLog;

    mapping(bytes32 => ApprovalRequest) public requests;
    mapping(bytes32 => ApprovalResult)  public results;
    mapping(string => bytes) public approvalDecisions;

    uint256 private _nonce;

    event ApprovalRequested(bytes32 indexed requestId, address indexed requester, string prId, bytes32 indexed traceId, string reviewerAgent, uint256 timestamp);
    event PRApproved(bytes32 indexed requestId, bytes32 indexed traceId, uint256 agentId, uint256 timestamp);
    event RevisionRequested(bytes32 indexed requestId, bytes32 indexed traceId, uint256 agentId, uint256 timestamp);
    event PRRejected(bytes32 indexed requestId, bytes32 indexed traceId, uint256 agentId, uint256 timestamp);
    event ApprovalCancelled(bytes32 indexed requestId);

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

    function requestApproval(
        string calldata prId, bytes32 traceId,
        string calldata reviewerAgent, string calldata message
    ) external returns (bytes32 requestId) {
        require(bytes(prId).length > 0, "prId required");
        if (traceId == bytes32(0)) {
            traceId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce));
        }
        requestId = keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, _nonce++));
        requests[requestId] = ApprovalRequest(msg.sender, prId, traceId, reviewerAgent, message, block.timestamp, RequestStatus.Pending);
        emit ApprovalRequested(requestId, msg.sender, prId, traceId, reviewerAgent, block.timestamp);
        _recordHop(traceId, 0, "approvalRequested");
    }

    function fulfillApproval(uint256 agentId, bytes32 requestId, string calldata prId, bytes calldata reasonJson)
        external onlyRegisteredOracle(agentId)
    {
        bytes32 traceId = _validateAndSetStatus(requestId, prId, RequestStatus.Approved);
        approvalDecisions[prId] = bytes('"approved"');
        results[requestId] = ApprovalResult(traceId, bytes('"approved"'), reasonJson, bytes(""), agentId, block.timestamp);
        emit PRApproved(requestId, traceId, agentId, block.timestamp);
        _recordHop(traceId, agentId, "approvalFulfilled");
    }

    function fulfillNeedsRevision(
        uint256 agentId, bytes32 requestId, string calldata prId,
        bytes calldata reasonJson, bytes calldata unresolvedJson
    ) external onlyRegisteredOracle(agentId) {
        bytes32 traceId = _validateAndSetStatus(requestId, prId, RequestStatus.NeedsRevision);
        approvalDecisions[prId] = bytes('"needs_revision"');
        results[requestId] = ApprovalResult(traceId, bytes('"needs_revision"'), reasonJson, unresolvedJson, agentId, block.timestamp);
        emit RevisionRequested(requestId, traceId, agentId, block.timestamp);
        _recordHop(traceId, agentId, "revisionRequested");
    }

    function fulfillRejection(uint256 agentId, bytes32 requestId, string calldata prId, bytes calldata reasonJson)
        external onlyRegisteredOracle(agentId)
    {
        bytes32 traceId = _validateAndSetStatus(requestId, prId, RequestStatus.Rejected);
        approvalDecisions[prId] = bytes('"rejected"');
        results[requestId] = ApprovalResult(traceId, bytes('"rejected"'), reasonJson, bytes(""), agentId, block.timestamp);
        emit PRRejected(requestId, traceId, agentId, block.timestamp);
        _recordHop(traceId, agentId, "rejectionFulfilled");
    }

    function getDecision(string calldata prId) external view returns (bytes memory) { return approvalDecisions[prId]; }

    function getRequestInfo(bytes32 requestId) external view
        returns (RequestStatus status, string memory prId, bytes32 traceId, address requester, uint256 createdAt)
    {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        return (req.status, req.prId, req.traceId, req.requester, req.createdAt);
    }

    function getResultInfo(bytes32 requestId) external view
        returns (bytes memory decision, bytes memory reason, bytes memory unresolvedBlockers, uint256 agentId, uint256 fulfilledAt)
    {
        require(requests[requestId].createdAt != 0, "unknown requestId");
        ApprovalResult storage res = results[requestId];
        return (res.decision, res.reason, res.unresolvedBlockers, res.agentId, res.fulfilledAt);
    }

    function cancelApproval(bytes32 requestId) external {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        require(req.requester == msg.sender, "not requester");
        require(req.status == RequestStatus.Pending, "not pending");
        req.status = RequestStatus.Cancelled;
        emit ApprovalCancelled(requestId);
    }

    function _validateAndSetStatus(bytes32 requestId, string calldata prId, RequestStatus newStatus)
        internal returns (bytes32 traceId)
    {
        ApprovalRequest storage req = requests[requestId];
        require(req.createdAt != 0, "unknown requestId");
        require(req.status == RequestStatus.Pending, "not pending");
        require(keccak256(bytes(req.prId)) == keccak256(bytes(prId)), "prId mismatch");
        traceId = req.traceId;
        req.status = newStatus;
    }

    function _recordHop(bytes32 traceId, uint256 agentId, string memory action) internal {
        if (address(traceLog) != address(0)) traceLog.recordHop(traceId, agentId, action);
    }
}
