exports.sendSingleThread = (req, res) => {
    const { fileNames } = req.body;
    console.log('단일 스레드 전송 데이터:', fileNames);
    // 여기에 실제 파일 처리 및 전송 로직 추가
    res.json({ message: '단일 스레드 전송 완료' });
};

exports.sendMultipleThread = (req, res) => {
    const { fileNames } = req.body;
    console.log('멀티 스레드 전송 데이터:', fileNames);
    // 여기에 멀티 스레드 로직 추가
    res.json({ message: '멀티 스레드 전송 완료' });
};