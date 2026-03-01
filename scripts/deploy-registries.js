const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying from:", deployer.address);

    // 1. Identity Registry (upgradeable proxy)
    const Identity = await hre.ethers.getContractFactory("IdentityRegistryUpgradeable");
    const identity = await hre.upgrades.deployProxy(Identity, [], { initializer: "initialize" });
    await identity.waitForDeployment();
    const identityAddr = await identity.getAddress();
    console.log("IdentityRegistry →", identityAddr);

    // 2. Reputation Registry (upgradeable proxy)
    const Reputation = await hre.ethers.getContractFactory("ReputationRegistryUpgradeable");
    const reputation = await hre.upgrades.deployProxy(Reputation, [identityAddr], { initializer: "initialize" });
    await reputation.waitForDeployment();
    console.log("ReputationRegistry →", await reputation.getAddress());

    // 3. Execution Trace Log (plain deploy)
    const TraceLog = await hre.ethers.getContractFactory("ExecutionTraceLog");
    const traceLog = await TraceLog.deploy();
    await traceLog.waitForDeployment();
    const traceLogAddr = await traceLog.getAddress();
    console.log("ExecutionTraceLog →", traceLogAddr);

    // 4. Code Reviewer Oracle
    const ReviewerOracle = await hre.ethers.getContractFactory("CodeReviewerOracle");
    const reviewerOracle = await ReviewerOracle.deploy(identityAddr, traceLogAddr);
    await reviewerOracle.waitForDeployment();
    const reviewerOracleAddr = await reviewerOracle.getAddress();
    console.log("CodeReviewerOracle →", reviewerOracleAddr);

    // 5. Code Approver Oracle
    const ApproverOracle = await hre.ethers.getContractFactory("CodeApproverOracle");
    const approverOracle = await ApproverOracle.deploy(identityAddr, traceLogAddr);
    await approverOracle.waitForDeployment();
    const approverOracleAddr = await approverOracle.getAddress();
    console.log("CodeApproverOracle →", approverOracleAddr);

    console.log("\n--- Summary ---");
    console.log("IdentityRegistry:    ", identityAddr);
    console.log("ReputationRegistry:  ", await reputation.getAddress());
    console.log("ExecutionTraceLog:   ", traceLogAddr);
    console.log("CodeReviewerOracle:  ", reviewerOracleAddr);
    console.log("CodeApproverOracle:  ", approverOracleAddr);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});