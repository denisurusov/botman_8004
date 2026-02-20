const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying from:", deployer.address);

    const Identity = await hre.ethers.getContractFactory("IdentityRegistryUpgradeable");
    const identity = await hre.upgrades.deployProxy(Identity, [], { initializer: 'initialize' });
    await identity.waitForDeployment();
    console.log("IdentityRegistry →", await identity.getAddress());

    const Reputation = await hre.ethers.getContractFactory("ReputationRegistry");
    const reputation = await Reputation.deploy(await identity.getAddress());
    await reputation.waitForDeployment();
    console.log("ReputationRegistry →", await reputation.getAddress());

    // Optional: save addresses to file or hardhat.config
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});