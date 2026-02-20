const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying from:", deployer.address);

    const Identity = await hre.ethers.getContractFactory("IdentityRegistryUpgradeable");
    const identity = await hre.upgrades.deployProxy(Identity, [], { initializer: "initialize" });
    await identity.waitForDeployment();
    const identityAddr = await identity.getAddress();
    console.log("IdentityRegistry →", identityAddr);

    const Reputation = await hre.ethers.getContractFactory("ReputationRegistryUpgradeable");
    const reputation = await hre.upgrades.deployProxy(Reputation, [identityAddr], { initializer: "initialize" });
    await reputation.waitForDeployment();
    console.log("ReputationRegistry →", await reputation.getAddress());
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});