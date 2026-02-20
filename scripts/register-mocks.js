const hre = require("hardhat");
const fs = require("fs");

async function main() {
    const identityAddr = "0x..."; // ← paste from deploy output
    const identity = await hre.ethers.getContractAt("IdentityRegistryUpgradeable", identityAddr);

    const agents = [
        { file: "mock-agent-1.json", owner: (await hre.ethers.getSigners())[1] },
        { file: "mock-agent-2.json", owner: (await hre.ethers.getSigners())[2] },
        // add more
    ];

    for (const agent of agents) {
        const uri = `data:application/json;base64,${Buffer.from(fs.readFileSync(`agents/${agent.file}`)).toString('base64')}`;
        const tx = await identity.connect(agent.owner).register(uri, []); // no metadata for simplicity
        await tx.wait();
        console.log(`Registered ${agent.file} → tokenId ${await identity.totalSupply()}`);
    }
}

main().catch(console.error);