from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


output = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "reading-sample.pdf"
output.parent.mkdir(parents=True, exist_ok=True)

pdf = canvas.Canvas(str(output), pagesize=A4)
width, height = A4

pages = [
    (
        "The Architecture of Attention",
        [
            "In a post-industrial society, information becomes abundant while human attention becomes the true limiting factor of personal agency.",
            "A wealth of information creates a poverty of attention. Deep reading requires deliberate boundaries between focused thought and continuous notification.",
            "This page is generated locally for the BianDu PDF import test."
        ],
    ),
    (
        "Media and Cognitive Focus",
        [
            "Every medium constructs an invisible architecture that channels where our eyes and thoughts settle.",
            "The reader should be able to move to the next page, preserve the position, and add a local note.",
        ],
    ),
    (
        "Private Knowledge",
        [
            "Private knowledge grows when sources, notes, questions, and relationships remain traceable to their evidence.",
            "The final page verifies page navigation and progress restoration."
        ],
    ),
]

for page_number, (title, paragraphs) in enumerate(pages, start=1):
    pdf.setTitle("BianDu Reading Test")
    pdf.setAuthor("Local Test Fixture")
    pdf.setFont("Times-Bold", 20)
    pdf.drawString(72, height - 88, f"{page_number}. {title}")
    pdf.setFont("Times-Roman", 13)
    y = height - 132
    for paragraph in paragraphs:
        words = paragraph.split()
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if pdf.stringWidth(candidate, "Times-Roman", 13) > width - 144:
                pdf.drawString(72, y, line)
                y -= 20
                line = word
            else:
                line = candidate
        if line:
            pdf.drawString(72, y, line)
            y -= 34
    pdf.drawString(72, 54, f"Page {page_number} of {len(pages)}")
    pdf.showPage()

pdf.save()
print(output)
