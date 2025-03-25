// app.js
const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const fsSync = require("fs"); // 스트림 생성 등 동기적 기능용
const path = require("path");
const multer = require("multer");
const archiver = require("archiver"); // 압축 라이브러리
const WebSocket = require("ws");
const { Worker, isMainThread } = require("worker_threads");

const app = express();
const port = 8080;
const serverURL = "0.0.0.0";

app.use(cors());
app.use(express.json());

// multer 설정: 파일들을 "uploads" 폴더에 저장
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/"); // 업로드 폴더 (미리 생성 필요)
    },
    filename: (req, file, cb) => {
        // 파일 원본명을 그대로 사용
        cb(null, file.originalname);
    }
});
// upload.fields()를 사용하여 "files" 필드로 최대 10개 파일 허용
const upload = multer({ storage }).fields([{ name: "files" }]);

// 업로드된 파일들을 정적 파일로 서비스 (다운로드 URL 제공)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 다중 파일 업로드 및 압축 엔드포인트
app.post("/upload", (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            console.error("multer 에러:", err);
            return res.status(400).json({ message: "파일 업로드 실패", error: err.message });
        }
        if (!req.files || !req.files["files"] || req.files["files"].length === 0) {
            return res.status(400).json({ message: "파일 업로드 실패" });
        }

        // zip 파일 생성
        const zipFileName = `archive_${Date.now()}.zip`;
        const zipFilePath = path.join(__dirname, "uploads", zipFileName);
        const output = fsSync.createWriteStream(zipFilePath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", async () => {
            console.log("Zip 파일 생성 완료, 총 크기:", archive.pointer() + " bytes");

            for (const file of req.files["files"]) {
                try {
                    await fs.unlink(file.path);
                } catch (delErr) {
                    console.error(`${file.path}`, delErr);
                }
            }

            const downloadFiles = [{
                url: `http://${req.headers.host}/uploads/${encodeURIComponent(zipFileName)}`,
                displayName: zipFileName
            }];
            res.json({ message: "파일 업로드 및 압축 완료", downloadFiles });
        });

        archive.on("error", (err) => {
            console.error("압축 중 오류 발생:", err);
            return res.status(500).json({ message: "압축 실패", error: err.message });
        });

        archive.pipe(output);
        req.files["files"].forEach(file => {
            archive.file(file.path, { name: file.originalname });
        });
        await archive.finalize();
    });
});

// WebSocket 서버 설정 (옵션)
const wss = new WebSocket.Server({ noServer: true });
wss.on("connection", (ws) => {
    console.log("WebSocket 클라이언트와 연결됨");
    ws.on("message", (message) => {
        console.log("클라이언트로부터 받은 메시지:", message);
        ws.send(`서버에서 받은 메시지: ${message}`);
    });
    ws.on("close", () => {
        console.log("WebSocket 클라이언트와 연결 종료됨");
    });
});

// getFilePath 함수 수정: 우선 "uploads" 폴더에서 파일을 확인하도록 변경
const getFilePath = async (fileName) => {
    let filePath = path.resolve(__dirname, "uploads", fileName);
    try {
        await fs.access(filePath);
        return filePath;
    } catch (error) {
        filePath = path.resolve(__dirname, "files", fileName);
        try {
            await fs.access(filePath);
            return filePath;
        } catch (error) {
            filePath = path.resolve(__dirname, "files2", fileName);
            await fs.access(filePath);
            return filePath;
        }
    }
};

// 단일 스레드 파일 처리 함수
const processFileAsync = async (fileName) => {
    try {
        const filePath = await getFilePath(fileName);
        await fs.readFile(filePath);
        return `파일 처리 완료: ${fileName}`;
    } catch (error) {
        console.error("app.js - 파일 처리 중 오류 발생:", error);
        return `파일 처리 실패: ${fileName}`;
    }
};

// 멀티 스레드 처리 함수
function processFilesInWorker(fileNames, threads) {
    return new Promise((resolve, reject) => {
        const workerPath = path.resolve(__dirname, "workers", "worker.js");
        const worker = new Worker(workerPath);

        worker.on("message", (result) => {
            resolve(result);
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });

        worker.postMessage({ fileNames, threads });
    });
}

// 단일 스레드 전송 엔드포인트 (순차 처리)
// 클라이언트는 { fileNames: [...] } 형태로 데이터를 전송
app.post("/send-single", async (req, res) => {
    const { fileNames } = req.body;
    if (!fileNames || !Array.isArray(fileNames)) {
        return res.status(400).json({ message: "파일 이름 배열이 필요합니다." });
    }
    console.log("단일 스레드 전송, 파일 이름들:", fileNames);
    try {
        const startTime = Date.now();
        for (let fileName of fileNames) {
            const result = await processFileAsync(fileName);
            console.log(result);
        }
        const endTime = Date.now();
        const processingTime = endTime - startTime;
        console.log("총 처리 시간:", processingTime, "ms");
        res.json({ message: "단일 스레드 전송 완료", processingTime: `${processingTime} ms` });
    } catch (error) {
        console.error("단일 스레드 전송 중 오류 발생:", error);
        res.status(500).json({ message: "전송 실패", error: error.message });
    }
});

// 멀티 스레드 전송 엔드포인트 (병렬 처리)
// 클라이언트는 { fileNames: [...], threads: 숫자 } 형태로 데이터를 전송
app.post("/send-multiple", async (req, res) => {
    const { fileNames, threads } = req.body;
    if (!fileNames || !Array.isArray(fileNames)) {
        return res.status(400).json({ message: "파일 이름 배열이 필요합니다." });
    }
    console.log("멀티 스레드 전송, 파일 이름들:", fileNames, "스레드 수:", threads);
    try {
        const startTime = Date.now();
        const result = await processFilesInWorker(fileNames, threads);
        const endTime = Date.now();
        const processingTime = endTime - startTime;
        console.log("총 처리 시간:", processingTime, "ms");
        res.json({
            message: "멀티 스레드 전송 완료",
            results: result,
            processingTime: `${processingTime} ms`
        });
    } catch (error) {
        console.error("멀티 스레드 전송 중 오류 발생:", error);
        res.status(500).json({ message: "전송 실패", error: error.message });
    }
});

// 실험 결과 자동 저장 엔드포인트
app.post("/save-result", async (req, res) => {
    try {
        console.log("실험 결과 저장 요청:", req.body);
        const resultData = req.body; // 실험 결과 데이터
        const { experiment_datetime, file_count, single_thread_time, multi_thread_results } = resultData;
        const lines = [];
        lines.push("[실험 일시]");
        lines.push(experiment_datetime);
        lines.push("");
        lines.push("[실험 조건]");
        lines.push(`파일 수: ${file_count}개`);
        lines.push("");
        lines.push("[결과]");
        lines.push(`- 단일 스레드 처리 시간: ${single_thread_time}ms`);
        for (const threadCount in multi_thread_results) {
            lines.push(`- 멀티 스레드 처리 시간 (${threadCount} threads): ${multi_thread_results[threadCount]}ms`);
        }
        const content = lines.join("\n");

        const resultsDir = path.resolve(__dirname, "results");
        console.log("결과 저장 폴더 경로:", resultsDir);
        await fs.mkdir(resultsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.-]/g, "");
        const fileName = `Result_${timestamp}.txt`;
        const filePath = path.join(resultsDir, fileName);
        await fs.writeFile(filePath, content, { encoding: "utf-8" });
        console.log("실험 결과 파일 저장 완료:", filePath);
        res.json({ message: "실험 결과 저장 완료", filePath });
    } catch (error) {
        console.error("실험 결과 저장 중 오류 발생:", error);
        res.status(500).json({ message: "실험 결과 저장 실패", error: error.message });
    }
});

// 서버 실행 및 WebSocket 업그레이드 처리
app.server = app.listen(port, serverURL, () => {
    console.log(`서버가 ${port} 포트에서 실행 중입니다.`);
});

app.server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
    });
});

// 워커 스레드 코드는 worker.js에 따로 있음
if (!isMainThread) {
    // 이 부분은 실행되지 않습니다. 워커 스레드 코드는 workers/worker.js 파일에서 관리됩니다.
}