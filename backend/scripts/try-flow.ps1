# Walks the customer side of ChopList against a running server, printing what
# each step returns. Needs the demo seller (npm run seed:demo) and the server
# running (npm run dev). Windows PowerShell 5.1 or newer.
#
#   cd backend
#   powershell -ExecutionPolicy Bypass -File scripts\try-flow.ps1
#
# Rate limit: 20 orders per 10 minutes per IP. This script places 3, so about
# six runs in ten minutes will hit "429 RATE_LIMITED" (that is the limit working).

param([string]$BaseUrl = 'http://localhost:5000')

# Call the API; print "HTTP status" and the JSON body for errors instead of
# stopping. (PowerShell 5.1 keeps the error body in ErrorDetails.Message.)
function Call($Method, $Path, $Body = $null) {
  try {
    $req = @{ Method = $Method; Uri = "$BaseUrl$Path" }
    if ($Body) { $req.ContentType = 'application/json'; $req.Body = ($Body | ConvertTo-Json -Depth 6) }
    return Invoke-RestMethod @req
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    Write-Host "   -> HTTP $code $($_.ErrorDetails.Message)" -ForegroundColor Yellow
    return $null
  }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step '1. Is the server up?'
(Call GET '/health') | Format-List

Step '2. Seller route without a token (expect 401)'
Call GET '/api/sellers/me' | Out-Null

Step "3. A customer opens the seller's link"
$page = Call GET '/api/public/menu/demo-kitchen'
if (-not $page -or -not $page.menu) { Write-Host 'No open demo menu. Run npm run seed:demo first.' -ForegroundColor Red; return }
Write-Host "$($page.seller.businessName)  |  $($page.menu.title)  |  accepting orders: $($page.menu.acceptingOrders)"
$page.menu.items | Format-Table name, price, qtyRemaining, soldOut -AutoSize
$jollof  = $page.menu.items | Where-Object name -eq 'Jollof rice'
$chapman = $page.menu.items | Where-Object name -eq 'Chapman'
$day = $page.menu.deliveryDays[0]

function NewOrder($name, $phone, $area, $lines) {
  return @{
    menuId   = $page.menu.id
    customer = @{ name = $name; phone = $phone }
    delivery = @{ area = $area; address = '12 Herbert Macaulay Way'; day = $day }
    lines    = $lines
  }
}

Step '4. Ada orders 2 Jollof + 1 Chapman (phone typed the Nigerian way)'
$ada = Call POST '/api/public/orders' (NewOrder 'Ada' '0809 111 2222' 'yaba' @(
  @{ itemId = $jollof.id; qty = 2 }, @{ itemId = $chapman.id; qty = 1 }))
if ($ada) {
  Write-Host "Reference: $($ada.order.ref)   Total: N$($ada.order.total)   Status: $($ada.order.status)"
  Write-Host $ada.payment.instructions -ForegroundColor Green
}

Step '5. Ada checks her order later (reference + last 4 digits of her phone)'
if ($ada) {
  (Call GET "/api/public/orders/$($ada.order.ref)?phoneLast4=2222").order | Format-List ref, status, total, customerName
  Write-Host 'Wrong digits (expect 404, same as an unknown reference):'
  Call GET "/api/public/orders/$($ada.order.ref)?phoneLast4=0000" | Out-Null
}

Step '6. Prices sent by the customer are ignored'
$cheat = NewOrder 'Cheeky' '0803 000 1111' 'Yaba' @(@{ itemId = $chapman.id; qty = 1; price = 1; unitPrice = 1 })
$cheat.total = 1
$c = Call POST '/api/public/orders' $cheat
if ($c) { Write-Host "Customer claimed N1; server charged N$($c.order.total) ($($c.order.lines[0].name) at N$($c.order.lines[0].unitPrice))" }

Step '7. Someone asks for more Jollof than is left (expect 409 SOLD_OUT, nothing taken)'
$left = (Call GET '/api/public/menu/demo-kitchen').menu.items | Where-Object name -eq 'Jollof rice'
Write-Host "Jollof left before: $($left.qtyRemaining)"
Call POST '/api/public/orders' (NewOrder 'Greedy' '0803 222 3333' 'Yaba' @(@{ itemId = $jollof.id; qty = 50 })) | Out-Null
$left = (Call GET '/api/public/menu/demo-kitchen').menu.items | Where-Object name -eq 'Jollof rice'
Write-Host "Jollof left after:  $($left.qtyRemaining)"

Step '8. A delivery area the seller does not serve (expect 400 INVALID_AREA)'
Call POST '/api/public/orders' (NewOrder 'Far Away' '0803 444 5555' 'Lekki' @(@{ itemId = $jollof.id; qty = 1 })) | Out-Null

Step '9. Final stock on the public page'
(Call GET '/api/public/menu/demo-kitchen').menu.items | Format-Table name, qtyRemaining, soldOut -AutoSize

Write-Host "`nSeller actions (list orders, mark paid, cancel, prep sheet, delivery list) need a real Clerk token; see docs/api.md." -ForegroundColor DarkGray
