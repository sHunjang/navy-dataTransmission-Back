// workers/worker.js
const { parentPort } = require("worker_threads");
const fs = require("fs").promises;
const path = require("path");

// "files" 폴더와 "files2" 폴더에서 파일 존재 여부를 확인하는 함수
const getFilePath = async (fileName) => {
    // 우선 "files" 폴더에서 확인
    let filePath = path.resolve(__dirname, "..", "files", fileName);
    try {
        await fs.access(filePath);
        return filePath;
    } catch (error) {
        // "files"에 없으면 "files2" 폴더에서 확인
        filePath = path.resolve(__dirname, "..", "files2", fileName);
        await fs.access(filePath);
        return filePath;
    }
};

const processFileAsync = async (fileName) => {
    try {
        const filePath = await getFilePath(fileName);
        await fs.readFile(filePath);
        return `파일 처리 완료: ${fileName}`;
    } catch (error) {
        console.error("worker.js - 파일 처리 중 오류 발생:", error);
        return `파일 처리 실패: ${fileName}`;
    }
};

parentPort.on("message", async ({ fileNames, threads }) => {
    try {
        const numThreads = Number(threads) || 1;
        const chunkSize = Math.ceil(fileNames.length / numThreads);
        const results = await Promise.all(
            Array.from({ length: numThreads }).map((_, i) => {
                const chunk = fileNames.slice(i * chunkSize, (i + 1) * chunkSize);
                return Promise.all(chunk.map((file) => processFileAsync(file)));
            })
        );
        parentPort.postMessage(results.flat());
    } catch (error) {
        parentPort.postMessage({ error: error.message });
    }
});