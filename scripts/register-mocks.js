const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Paste the IdentityRegistry proxy address from deploy-registries.js output
const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY_ADDRESS || "0x...";

async function main() {
    if (IDENTITY_REGISTRY_ADDRESS === "0x...") {
        throw new Error(
            "Set IDENTITY_REGISTRY_ADDRESS env var or edit the constant in this script.\n" +
            "Example: $env:IDENTITY_REGISTRY_ADDRESS='0xYourAddress'; npx hardhat run scripts/register-mocks.js --network localhost"
        );
    }

    const signers = await hre.ethers.getSigners();
    const identity = await hre.ethers.getContractAt("IdentityRegistryUpgradeable", IDENTITY_REGISTRY_ADDRESS);

    const agentsDir = path.join(__dirname, "..", "agents");
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json")).sort();

    console.log(`Registering ${agentFiles.length} agents against ${IDENTITY_REGISTRY_ADDRESS}\n`);

    for (let i = 0; i < agentFiles.length; i++) {
        const file = agentFiles[i];
        const owner = signers[i + 1] ?? signers[0]; // signers[1..N], fall back to deployer

        const json = fs.readFileSync(path.join(agentsDir, file), "utf8");
        const uri = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;

        const tx = await identity.connect(owner)["register(string)"](uri);
        const receipt = await tx.wait();

        const event = receipt.logs
            .map(log => { try { return identity.interface.parseLog(log); } catch { return null; } })
            .find(e => e?.name === "Registered");

        const agentId = event?.args?.agentId ?? "?";
        console.log(`✓ ${file.padEnd(12)} agentId=${agentId}  owner=${owner.address}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
